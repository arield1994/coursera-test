/**
 * Answers the app's /api/* calls in the browser, so the real page components
 * run unmodified in a single static page.
 *
 * The route handlers themselves can't be reused here — they're tied to
 * next/server and, for ingest, node:crypto. What *is* reused is everything
 * that matters: the same scanner, arbitrage, de-vig, ingest validation and
 * merge code the server runs. Only the thin query-string parsing is restated
 * below, so the numbers on screen are produced by the real engine.
 */

import { generateMockEvents, MOCK_SPORTS } from "../src/lib/providers/mock";
import { scanForEv, DEFAULT_SCAN_OPTIONS } from "../src/lib/ev/scanner";
import {
  findArbitrage,
  findMiddles,
  DEFAULT_ARB_OPTIONS,
  DEFAULT_MIDDLE_OPTIONS,
} from "../src/lib/ev/arbitrage";
import { DEFAULT_SHARP_BOOKS } from "../src/lib/odds/books";
import { DEVIG_METHODS, type DevigMethod } from "../src/lib/ev/devig";
import { activeSources, putSource, removeSource } from "../src/lib/ingest/store";
import { attachCustomLines } from "../src/lib/ingest/merge";
import { IngestError, validatePayload } from "../src/lib/ingest/types";
import type { GameEvent } from "../src/lib/odds/types";

const list = (p: URLSearchParams, key: string, fallback: string[] = []) => {
  const raw = p.get(key);
  if (raw === null) return fallback;
  const values = raw.split(",").map((v) => v.trim()).filter(Boolean);
  return values.length > 0 ? values : fallback;
};

const num = (p: URLSearchParams, key: string, fallback: number) => {
  const raw = p.get(key);
  if (raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const devig = (p: URLSearchParams): DevigMethod => {
  const raw = p.get("devig") as DevigMethod | null;
  return raw && DEVIG_METHODS.includes(raw) ? raw : DEFAULT_SCAN_OPTIONS.devigMethod;
};

/**
 * One generated board per page load. Regenerating per request would make
 * kickoff times drift and rows flicker on every poll.
 */
let board: GameEvent[] | null = null;
function baseEvents(): GameEvent[] {
  if (!board) board = generateMockEvents({ seed: Math.floor(Math.random() * 100000) });
  return board;
}

function feed(params: URLSearchParams) {
  const sports = new Set(list(params, "sports", MOCK_SPORTS.map((s) => s.key)));
  const markets = new Set(list(params, "markets", ["h2h", "spreads", "totals"]));

  const sliced = baseEvents()
    .filter((e) => sports.has(e.sportKey))
    .map((e) => ({ ...e, markets: e.markets.filter((m) => markets.has(m.marketKey)) }));

  // Same merge the server does, so pushed lines behave identically here.
  const { events } = attachCustomLines(sliced, activeSources());
  return events.map((e) => ({
    ...e,
    markets: e.markets.filter((m) => markets.has(m.marketKey)),
  }));
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const envelope = (data: unknown, meta: Record<string, unknown>) =>
  json({ ok: true, updatedAt: new Date().toISOString(), ...meta, data });

async function handle(url: URL, init?: RequestInit): Promise<Response> {
  const p = url.searchParams;

  switch (url.pathname) {
    case "/api/sports":
      return envelope(MOCK_SPORTS, { demo: true });

    case "/api/odds": {
      const events = feed(p);
      return envelope(events, { demo: true, eventCount: events.length });
    }

    case "/api/scan": {
      const events = feed(p);
      const found = scanForEv(events, {
        devigMethod: devig(p),
        sharpBooks: list(p, "sharp", DEFAULT_SHARP_BOOKS),
        targetBooks: list(p, "books"),
        marketKeys: list(p, "markets"),
        minEvPercent: num(p, "minEv", DEFAULT_SCAN_OPTIONS.minEvPercent),
        maxEvPercent: num(p, "maxEv", DEFAULT_SCAN_OPTIONS.maxEvPercent),
        minSharpBooks: num(p, "minSharp", 1),
        maxHoursAhead: num(p, "maxHours", 0),
        stake: {
          bankroll: num(p, "bankroll", 1000),
          kellyMultiplier: num(p, "kelly", 0.25),
          maxStakeFraction: num(p, "maxStake", 0.05),
        },
      });
      return envelope(found.slice(0, num(p, "limit", 300)), {
        demo: true,
        eventCount: events.length,
        total: found.length,
      });
    }

    case "/api/arbitrage": {
      const events = feed(p);
      const arbs = findArbitrage(events, {
        totalStake: num(p, "stake", DEFAULT_ARB_OPTIONS.totalStake),
        minProfitPercent: num(p, "minProfit", DEFAULT_ARB_OPTIONS.minProfitPercent),
        maxProfitPercent: num(p, "maxProfit", DEFAULT_ARB_OPTIONS.maxProfitPercent),
        marketKeys: list(p, "markets"),
        maxHoursAhead: num(p, "maxHours", 0),
      });
      return envelope(arbs, { demo: true, eventCount: events.length, total: arbs.length });
    }

    case "/api/middles": {
      const events = feed(p);
      const middles = findMiddles(events, {
        totalStake: num(p, "stake", DEFAULT_MIDDLE_OPTIONS.totalStake),
        maxCostPercent: num(p, "maxCost", DEFAULT_MIDDLE_OPTIONS.maxCostPercent),
        minWindowWidth: num(p, "minWidth", DEFAULT_MIDDLE_OPTIONS.minWindowWidth),
        maxHoursAhead: num(p, "maxHours", 0),
      });
      return envelope(middles, {
        demo: true,
        eventCount: events.length,
        total: middles.length,
      });
    }

    case "/api/sources":
      return json({
        ok: true,
        // The demo has no server, so there is no token to configure and
        // nothing to poll -- pushing from this page is the whole story.
        ingestConfigured: false,
        pullConfigured: 0,
        sources: activeSources().map((s) => ({
          key: s.book.key,
          title: s.book.title,
          sharp: s.book.sharp,
          sharpWeight: s.book.sharpWeight,
          lines: s.lines.length,
          receivedAt: new Date(s.receivedAt).toISOString(),
          expiresAt: new Date(s.expiresAt).toISOString(),
          ttlSeconds: s.ttlSeconds,
          createMissingEvents: s.createMissingEvents,
          origin: "push",
          matched: s.lastMatched ?? null,
          unmatched: s.lastUnmatched ?? null,
        })),
      });

    case "/api/ingest": {
      if ((init?.method ?? "GET").toUpperCase() === "DELETE") {
        return json({ ok: true, removed: removeSource(p.get("book") ?? "") });
      }
      try {
        const result = validatePayload(JSON.parse(String(init?.body ?? "{}")));
        if (result.lines.length === 0) {
          return json(
            {
              ok: false,
              error: "No usable lines in payload.",
              rejected: result.errors.length,
              errors: result.errors.slice(0, 20),
            },
            422,
          );
        }
        const stored = putSource(result);
        // Re-run the merge so the Sources screen shows match counts straight
        // away instead of after the next poll.
        attachCustomLines(baseEvents(), activeSources());
        return json({
          ok: true,
          book: stored.book,
          accepted: result.lines.length,
          rejected: result.errors.length,
          errors: result.errors.slice(0, 20),
          expiresAt: new Date(stored.expiresAt).toISOString(),
        });
      } catch (error) {
        const status = error instanceof IngestError ? 400 : 500;
        return json({ ok: false, error: (error as Error).message }, status);
      }
    }

    default:
      return json({ ok: false, error: `No demo handler for ${url.pathname}` }, 404);
  }
}

/** Route /api/* to the in-browser engine; let everything else through. */
export function installApiShim(): void {
  const original = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, window.location.origin);
    if (!url.pathname.startsWith("/api/")) return original(input as RequestInfo, init);
    return handle(url, init);
  };
}
