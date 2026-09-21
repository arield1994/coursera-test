/**
 * Pulling lines from a private bookie API.
 *
 * The push route (/api/ingest) suits a scraper you control. This is the other
 * half: point EdgeScan at an HTTP endpoint that already returns odds, describe
 * where the fields live, and it polls on its own.
 *
 * Rather than requiring the endpoint to speak our schema, a small field mapping
 * translates it. Whatever comes out is then run through exactly the same
 * validation as a pushed payload, so there is only one definition of what a
 * usable line is.
 */

import { validatePayload, type IngestPayload } from "./types";
import { putSource } from "./store";

export interface FieldMapping {
  /** Dotted path to the array of games. Omit if the body is already an array. */
  lines?: string;
  /** All relative to a game. */
  home: string;
  away: string;
  commenceTime?: string;
  sport?: string;
  /**
   * Path, relative to a game, to an array of market objects — the common
   * shape where one game carries its moneyline, spread and total together.
   *
   * When set, `market` and `outcomes` resolve against each market object and
   * every market becomes its own line. Without it only one market per game
   * could ever be read.
   */
  markets?: string;
  /** Relative to a market object when `markets` is set, else to the game. */
  market?: string;
  /** Fixed market key, for endpoints that serve one market per URL. */
  marketKey?: string;
  /** Relative to a market object when `markets` is set, else to the game. */
  outcomes: string;
  /** All relative to an outcome. */
  outcomeName: string;
  american?: string;
  decimal?: string;
  point?: string;
  description?: string;
}

export interface PullSourceConfig {
  key: string;
  title?: string;
  url: string;
  headers?: Record<string, string>;
  sharp?: boolean;
  sharpWeight?: number;
  ttlSeconds?: number;
  createMissingEvents?: boolean;
  mapping: FieldMapping;
}

/** Read a dotted path, tolerating arrays and missing intermediate keys. */
export function readPath(source: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let current = source;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  // Odds arrive as strings more often than not: "+150", "-110", "2.50".
  if (typeof value === "string") {
    const parsed = Number(value.replace(/^\+/, "").trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * Translate a private API's response into our ingest payload shape.
 *
 * Exported separately from the fetch so a mapping can be tested — and
 * previewed in the UI — against a pasted sample response without any network
 * access or credentials.
 */
export function applyMapping(body: unknown, config: PullSourceConfig): IngestPayload {
  const { mapping } = config;
  const raw = mapping.lines ? readPath(body, mapping.lines) : body;
  const games = Array.isArray(raw) ? raw : [];

  const lines: IngestPayload["lines"] = [];

  for (const game of games) {
    const home = asString(readPath(game, mapping.home)) ?? "";
    const away = asString(readPath(game, mapping.away)) ?? "";
    const sport = asString(readPath(game, mapping.sport));
    const commenceTime = asString(readPath(game, mapping.commenceTime));

    // Either the game carries an array of markets, or it *is* one market.
    const marketNodes = mapping.markets
      ? (() => {
          const found = readPath(game, mapping.markets);
          return Array.isArray(found) ? found : [];
        })()
      : [game];

    for (const node of marketNodes) {
      const outcomesRaw = readPath(node, mapping.outcomes);
      const outcomes = Array.isArray(outcomesRaw) ? outcomesRaw : [];
      if (outcomes.length === 0) continue;

      lines.push({
        home,
        away,
        sport,
        commenceTime,
        market:
          config.mapping.marketKey ??
          asString(readPath(node, mapping.market)) ??
          "h2h",
        outcomes: outcomes.map((outcome) => ({
          name: asString(readPath(outcome, mapping.outcomeName)) ?? "",
          american: asNumber(readPath(outcome, mapping.american)),
          decimal: asNumber(readPath(outcome, mapping.decimal)),
          point: asNumber(readPath(outcome, mapping.point)),
          description: asString(readPath(outcome, mapping.description)),
        })),
      });
    }
  }

  return {
    book: {
      key: config.key,
      title: config.title,
      sharp: config.sharp,
      sharpWeight: config.sharpWeight,
    },
    ttlSeconds: config.ttlSeconds,
    createMissingEvents: config.createMissingEvents,
    replace: true,
    lines,
  };
}

export interface PullOutcome {
  key: string;
  ok: boolean;
  lines: number;
  dropped: number;
  error?: string;
  errors?: string[];
}

/** Read the configured pull sources from the environment. */
export function pullSourceConfigs(): PullSourceConfig[] {
  const raw = process.env.CUSTOM_SOURCES?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PullSourceConfig[]) : [];
  } catch {
    // A malformed config must not take the whole board down; the sources page
    // surfaces the problem instead.
    return [];
  }
}

export async function pullSource(config: PullSourceConfig): Promise<PullOutcome> {
  try {
    const response = await fetch(config.url, {
      headers: { Accept: "application/json", ...(config.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return {
        key: config.key,
        ok: false,
        lines: 0,
        dropped: 0,
        error: `${config.url} returned ${response.status}`,
      };
    }

    const result = validatePayload(applyMapping(await response.json(), config));
    putSource(result);

    return {
      key: config.key,
      ok: true,
      lines: result.lines.length,
      dropped: result.errors.length,
      errors: result.errors.slice(0, 5),
    };
  } catch (cause) {
    return {
      key: config.key,
      ok: false,
      lines: 0,
      dropped: 0,
      error: (cause as Error).message,
    };
  }
}

/** Poll every configured source. One failure never blocks the others. */
export async function pullAllSources(): Promise<PullOutcome[]> {
  const configs = pullSourceConfigs();
  if (configs.length === 0) return [];
  return Promise.all(configs.map(pullSource));
}
