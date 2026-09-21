/**
 * Shared request handling for the odds endpoints.
 *
 * All the scanner endpoints take the same "which games, which markets" slice of
 * query parameters and differ only in what they compute from it, so parsing and
 * fetching live here and the routes stay thin.
 */

import { NextResponse } from "next/server";
import { cached } from "./cache";
import {
  DEFAULT_MARKET_KEYS,
  DEFAULT_SPORT_KEYS,
  ODDS_TTL_MS,
  getProvider,
} from "./providers";
import { ProviderError } from "./providers/types";
import type { GameEvent } from "./odds/types";
import { DEVIG_METHODS, type DevigMethod } from "./ev/devig";
import { activeSources, recordMatchStats } from "./ingest/store";
import { attachCustomLines, type MergeStats } from "./ingest/merge";
import { pullAllSources, pullSourceConfigs } from "./ingest/pull";

export function list(params: URLSearchParams, key: string, fallback: string[] = []): string[] {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

export function num(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function bool(params: URLSearchParams, key: string, fallback = false): boolean {
  const raw = params.get(key);
  if (raw === null) return fallback;
  return raw === "1" || raw === "true";
}

export function devigMethod(params: URLSearchParams, fallback: DevigMethod): DevigMethod {
  const raw = params.get("devig") as DevigMethod | null;
  return raw && DEVIG_METHODS.includes(raw) ? raw : fallback;
}

export interface FeedSlice {
  events: GameEvent[];
  demo: boolean;
  sportKeys: string[];
  marketKeys: string[];
  /** Per-source match counts, so a misconfigured scraper is visible. */
  custom: MergeStats[];
}

/** How long a pull source's response is reused before polling it again. */
export const PULL_TTL_MS = Number(process.env.CUSTOM_SOURCE_TTL_MS ?? 20_000);

/**
 * Fetch the requested slice of the board, cached per (sports, markets) shape.
 *
 * The cache key deliberately ignores the scanner's own knobs — de-vig method,
 * minimum edge, bankroll — because those are applied after the fetch. Changing
 * a filter in the UI must never cost an upstream request.
 */
export async function loadEvents(params: URLSearchParams): Promise<FeedSlice> {
  const sportKeys = list(params, "sports", DEFAULT_SPORT_KEYS);
  const marketKeys = list(params, "markets", DEFAULT_MARKET_KEYS);
  const provider = getProvider();

  const key = `odds:${provider.name}:${[...sportKeys].sort().join(",")}:${[...marketKeys].sort().join(",")}`;
  const base = await cached(key, ODDS_TTL_MS, () =>
    provider.fetchOdds({ sportKeys, marketKeys }),
  );

  // Poll any configured private-API sources on their own schedule, then fold
  // both them and anything pushed to /api/ingest onto the board.
  if (pullSourceConfigs().length > 0) {
    await cached("pull:sources", PULL_TTL_MS, () => pullAllSources());
  }

  const sources = activeSources();
  const marketFilter = new Set(marketKeys);
  const { events, stats } = attachCustomLines(base, sources);
  for (const stat of stats) {
    recordMatchStats(stat.book, stat.matched, stat.unmatched);
  }

  // Custom sources may carry markets the caller did not ask for.
  const filtered =
    marketFilter.size === 0
      ? events
      : events.map((event) => ({
          ...event,
          markets: event.markets.filter((m) => marketFilter.has(m.marketKey)),
        }));

  return { events: filtered, demo: provider.isDemo, sportKeys, marketKeys, custom: stats };
}

export function ok<T>(data: T, meta: Record<string, unknown>) {
  return NextResponse.json(
    { ok: true, updatedAt: new Date().toISOString(), ...meta, data },
    // The client polls; the server-side cache is what protects provider quota.
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function fail(error: unknown) {
  if (error instanceof ProviderError) {
    return NextResponse.json(
      { ok: false, error: error.message, hint: error.hint },
      { status: error.status === 401 ? 401 : 502 },
    );
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return NextResponse.json({ ok: false, error: message }, { status: 500 });
}
