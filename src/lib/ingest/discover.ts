/**
 * Finding a bookmaker's odds endpoint from a browser network capture.
 *
 * Almost every sportsbook site is a JavaScript front end talking to its own
 * JSON API. You do not have to guess where that API is: load the page with the
 * network tab recording, save a HAR, and the request is in there — along with
 * the exact headers that made it work.
 *
 * This reads such a capture, scores every JSON response for how much it looks
 * like odds, and works out the field mapping so the result can go straight into
 * CUSTOM_SOURCES. The inference is heuristic and says how confident it is; the
 * Sources screen is where you check it against a real response.
 */

import type { FieldMapping } from "./pull";

const TEAM_HOME = /^(home|home_?team|home_?name|homeTeam|host|team_?1|competitor_?1)$/i;
const TEAM_AWAY = /^(away|away_?team|away_?name|awayTeam|guest|visitor|team_?2|competitor_?2)$/i;
const TIME_KEY = /(start|commence|kick_?off|scheduled|event_?date|game_?time|date_?time)/i;
const MARKET_KEY = /^(market|market_?type|market_?name|type|bet_?type|category|period)$/i;
const NAME_KEY = /^(name|label|title|selection|selection_?name|outcome|outcome_?name|participant|team|runner|description)$/i;
const PRICE_KEY = /(price|odds|american|decimal|moneyline|money_?line|cote|quote)/i;
const POINT_KEY = /^(point|points|handicap|line|spread|total|threshold|hdp|value)$/i;

/** Paths that are obviously not an odds feed, so we never rank them. */
const URL_DENYLIST = /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|mp4|webp)(\?|$)|google|facebook|doubleclick|segment|sentry|datadog|hotjar|analytics|gtm|optimizely/i;

export interface DiscoveredSource {
  url: string;
  method: string;
  /** 0-1; how strongly this response looks like a usable odds feed. */
  confidence: number;
  /** Games found in the sample response. */
  gameCount: number;
  outcomeCount: number;
  mapping: FieldMapping;
  /** Header names the request carried that are likely required. */
  authHeaders: string[];
  notes: string[];
}

type Json = unknown;

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArrayOfObjects(value: Json): value is Record<string, Json>[] {
  return Array.isArray(value) && value.length > 0 && value.every(isObject);
}

/** Every path holding an array of objects, breadth-first, shallowest first. */
function arrayPaths(root: Json, maxDepth = 6): { path: string; items: Record<string, Json>[] }[] {
  const found: { path: string; items: Record<string, Json>[] }[] = [];
  const queue: { node: Json; path: string; depth: number }[] = [{ node: root, path: "", depth: 0 }];

  while (queue.length > 0) {
    const { node, path, depth } = queue.shift()!;
    if (depth > maxDepth) continue;

    if (isArrayOfObjects(node)) found.push({ path, items: node });

    if (isObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        queue.push({ node: child, path: path ? `${path}.${key}` : key, depth: depth + 1 });
      }
    } else if (Array.isArray(node) && node.length > 0) {
      // Descend one representative element so nested arrays stay reachable.
      queue.push({ node: node[0], path: path ? `${path}.0` : "0", depth: depth + 1 });
    }
  }
  return found;
}

/** Find a key matching a pattern, looking one level into nested objects too. */
function findKey(
  item: Record<string, Json>,
  pattern: RegExp,
  accept: (value: Json) => boolean,
  prefix = "",
  depth = 0,
): string | undefined {
  for (const [key, value] of Object.entries(item)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (pattern.test(key) && accept(value)) return path;
  }
  if (depth >= 1) return undefined;
  for (const [key, value] of Object.entries(item)) {
    if (isObject(value)) {
      const nested = findKey(value, pattern, accept, prefix ? `${prefix}.${key}` : key, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

const isString = (v: Json) => typeof v === "string" && v.length > 0;
const isNumeric = (v: Json) =>
  typeof v === "number" || (typeof v === "string" && Number.isFinite(Number(v.replace(/^\+/, ""))));
const isDateish = (v: Json) =>
  (typeof v === "string" && Number.isFinite(Date.parse(v))) ||
  (typeof v === "number" && v > 1_000_000_000);

interface OutcomeLocation {
  /** Path from the game to an array of market objects, when there is one. */
  markets?: string;
  /** Path to the outcomes array, relative to a market node (or the game). */
  outcomes: string;
  /** The market node to read market names and outcome fields from. */
  node: Record<string, Json>;
}

/**
 * Locate a game's prices.
 *
 * `{ markets: [ { type, outcomes: [...] } ] }` is the shape most books use,
 * and it matters that it is recognised as a *markets array* rather than as
 * "the outcomes of the first market" — otherwise only one market per game is
 * ever read, and its name is lost.
 */
function findOutcomesPath(game: Record<string, Json>): OutcomeLocation | undefined {
  // The game itself carries the outcomes.
  for (const [key, value] of Object.entries(game)) {
    if (isArrayOfObjects(value) && looksLikeOutcomes(value)) {
      return { outcomes: key, node: game };
    }
  }

  // The game carries an array of markets, each with its own outcomes.
  for (const [key, value] of Object.entries(game)) {
    if (!isArrayOfObjects(value)) continue;
    for (const [innerKey, innerValue] of Object.entries(value[0])) {
      if (isArrayOfObjects(innerValue) && looksLikeOutcomes(innerValue)) {
        return { markets: key, outcomes: innerKey, node: value[0] };
      }
    }
  }

  // A single market hanging off an object rather than an array.
  for (const [key, value] of Object.entries(game)) {
    if (!isObject(value)) continue;
    for (const [innerKey, innerValue] of Object.entries(value)) {
      if (isArrayOfObjects(innerValue) && looksLikeOutcomes(innerValue)) {
        return { outcomes: `${key}.${innerKey}`, node: value };
      }
    }
  }

  return undefined;
}

function looksLikeOutcomes(items: Record<string, Json>[]): boolean {
  const sample = items[0];
  const hasPrice = findKey(sample, PRICE_KEY, isNumeric) !== undefined;
  const hasName = findKey(sample, NAME_KEY, isString) !== undefined;
  return hasPrice && hasName;
}

/**
 * One representative outcome object from every market we can reach, across the
 * first several games, so field detection sees the union of what the feed uses.
 */
function collectOutcomeSamples(
  games: Record<string, Json>[],
  location: OutcomeLocation,
  maxGames = 5,
  maxMarkets = 12,
): Record<string, Json>[] {
  const samples: Record<string, Json>[] = [];

  for (const game of games.slice(0, maxGames)) {
    const nodes = location.markets
      ? (() => {
          const found = readPathLocal(game, location.markets!);
          return isArrayOfObjects(found) ? found.slice(0, maxMarkets) : [];
        })()
      : [game];

    for (const node of nodes) {
      const outcomes = readPathLocal(node, location.outcomes);
      if (isArrayOfObjects(outcomes)) samples.push(...outcomes.slice(0, 3));
    }
  }
  return samples;
}

/** First key matching the pattern in any of the samples. */
function findAcross(
  samples: Record<string, Json>[],
  pattern: RegExp,
  accept: (value: Json) => boolean,
): string | undefined {
  for (const sample of samples) {
    const hit = findKey(sample, pattern, accept);
    if (hit) return hit;
  }
  return undefined;
}

export interface InferredMapping {
  mapping: FieldMapping;
  confidence: number;
  gameCount: number;
  outcomeCount: number;
  notes: string[];
}

/**
 * Work out a field mapping from one sample response body.
 *
 * Returns null when nothing in the body looks like a list of games with prices
 * — which is the common case for the dozens of tracking and asset requests in
 * any capture.
 */
export function inferMapping(body: Json): InferredMapping | null {
  let best: InferredMapping | null = null;

  for (const { path, items } of arrayPaths(body)) {
    const game = items[0];

    const home = findKey(game, TEAM_HOME, isString);
    const away = findKey(game, TEAM_AWAY, isString);
    const location = findOutcomesPath(game);
    if (!location) continue;

    const cursor = readPathLocal(location.node, location.outcomes);
    if (!isArrayOfObjects(cursor)) continue;

    // Field names must be learned across markets, not from the first one.
    // A moneyline's outcomes carry no line, so sampling only that market
    // would conclude the feed has no handicap field and silently drop every
    // spread and total number.
    const outcomeSamples = collectOutcomeSamples(items, location);
    const outcomeSample = outcomeSamples[0] ?? cursor[0];

    const outcomeName = findAcross(outcomeSamples, NAME_KEY, isString);
    if (!outcomeName) continue;

    const priceKey = findAcross(outcomeSamples, PRICE_KEY, isNumeric);
    if (!priceKey) continue;

    const commenceTime = findKey(game, TIME_KEY, isDateish);
    // The market name lives on the market node, which is the game itself only
    // when the game is not carrying a markets array.
    const market = findKey(location.node, MARKET_KEY, isString);
    const point = findAcross(outcomeSamples, POINT_KEY, isNumeric);

    // American and decimal odds are told apart by magnitude: decimal prices
    // live just above 1, American ones are never between -100 and +100.
    const rawPrice = Number(
      String(readPathLocal(outcomeSample, priceKey)).replace(/^\+/, ""),
    );
    const american = Math.abs(rawPrice) >= 100;

    const notes: string[] = [];
    if (!home || !away) {
      notes.push(
        "Could not identify home/away fields — check them by hand; teams may be in a 'competitors' array.",
      );
    }
    if (!commenceTime) notes.push("No start-time field found; matching will rely on team names alone.");
    if (!market) notes.push("No market field found; defaulting every line to moneyline (h2h).");

    const mapping: FieldMapping = {
      ...(path ? { lines: path } : {}),
      home: home ?? "home",
      away: away ?? "away",
      ...(commenceTime ? { commenceTime } : {}),
      ...(location.markets ? { markets: location.markets } : {}),
      ...(market ? { market } : { marketKey: "h2h" }),
      outcomes: location.outcomes,
      outcomeName,
      ...(american ? { american: priceKey } : { decimal: priceKey }),
      ...(point ? { point } : {}),
    };

    // Confidence is just how many of the fields we needed were actually found.
    const score =
      0.4 +
      (home && away ? 0.25 : 0) +
      (commenceTime ? 0.15 : 0) +
      (market ? 0.1 : 0) +
      (point ? 0.05 : 0) +
      Math.min(0.05, items.length / 200);

    const candidate: InferredMapping = {
      mapping,
      confidence: Math.min(1, score),
      gameCount: items.length,
      outcomeCount: cursor.length,
      notes,
    };

    if (!best || candidate.confidence > best.confidence) best = candidate;
  }

  return best;
}

function readPathLocal(source: Json, path: string): Json {
  let current: Json = source;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = Array.isArray(current)
      ? current[Number(segment)]
      : (current as Record<string, Json>)[segment];
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* HAR                                                                 */
/* ------------------------------------------------------------------ */

interface HarHeader {
  name: string;
  value: string;
}

interface HarEntry {
  request?: { url?: string; method?: string; headers?: HarHeader[] };
  response?: { content?: { mimeType?: string; text?: string }; status?: number };
}

/** Header names that usually carry the credential a request needs. */
const AUTH_HEADER = /^(authorization|x-api-key|x-auth|x-access-token|apikey|api-key|cookie|x-session|x-device|x-client|ocp-apim-subscription-key)/i;

/**
 * Rank every JSON response in a HAR by how much it looks like an odds feed.
 *
 * Header *names* are reported, never their values: a HAR contains live session
 * tokens, and the useful information is which headers to send, not what
 * yours happen to be.
 */
export function analyzeHar(har: unknown): DiscoveredSource[] {
  const entries = (har as { log?: { entries?: HarEntry[] } })?.log?.entries ?? [];
  const results: DiscoveredSource[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const url = entry.request?.url;
    if (!url || URL_DENYLIST.test(url)) continue;
    if ((entry.response?.status ?? 0) >= 400) continue;

    const text = entry.response?.content?.text;
    if (!text || text.length < 40) continue;

    const mime = entry.response?.content?.mimeType ?? "";
    if (!mime.includes("json") && !text.trimStart().startsWith("{") && !text.trimStart().startsWith("[")) {
      continue;
    }

    let body: Json;
    try {
      body = JSON.parse(text);
    } catch {
      continue;
    }

    const inferred = inferMapping(body);
    if (!inferred) continue;

    // Collapse the same endpoint called many times with different params.
    const key = url.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      url,
      method: entry.request?.method ?? "GET",
      confidence: inferred.confidence,
      gameCount: inferred.gameCount,
      outcomeCount: inferred.outcomeCount,
      mapping: inferred.mapping,
      authHeaders: (entry.request?.headers ?? [])
        .map((h) => h.name)
        .filter((name) => AUTH_HEADER.test(name)),
      notes: inferred.notes,
    });
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}

/* ------------------------------------------------------------------ */
/* Server-rendered books                                               */
/* ------------------------------------------------------------------ */

export interface HtmlCandidate {
  url: string;
  /** Count of American-odds-looking tokens in the document. */
  priceCount: number;
  bytes: number;
}

/** American odds as they appear in rendered markup: +150, -110, +1200. */
const PRICE_TOKEN = /(^|[\s>(])[+-]\d{3,4}(?=[\s<).,]|$)/g;

/**
 * Pages that render odds into HTML instead of serving JSON.
 *
 * Plenty of smaller books and agent portals have no front-end API at all: the
 * server returns a finished page. There is nothing to map in that case, so
 * these are reported separately and handled by scraping the page and pushing
 * to /api/ingest.
 */
export function findHtmlCandidates(har: unknown): HtmlCandidate[] {
  const entries = (har as { log?: { entries?: HarEntry[] } })?.log?.entries ?? [];
  const found: HtmlCandidate[] = [];

  for (const entry of entries) {
    const url = entry.request?.url;
    if (!url || URL_DENYLIST.test(url)) continue;
    if ((entry.response?.status ?? 0) >= 400) continue;

    const mime = entry.response?.content?.mimeType ?? "";
    const text = entry.response?.content?.text;
    if (!text || !mime.includes("html")) continue;

    const priceCount = (text.match(PRICE_TOKEN) ?? []).length;
    // A handful of numbers is a phone number or a date; a board has dozens.
    if (priceCount < 12) continue;

    found.push({ url, priceCount, bytes: text.length });
  }

  return found.sort((a, b) => b.priceCount - a.priceCount);
}

/* ------------------------------------------------------------------ */
/* Shareable summary                                                   */
/* ------------------------------------------------------------------ */

/**
 * Describe a JSON value's *shape* — keys and types, never values.
 *
 * A capture is full of session tokens, account identifiers and balances, so
 * this exists to make a capture safe to show someone else while keeping the
 * part that matters for building a mapping.
 */
export function describeShape(value: Json, depth = 0, maxDepth = 8): Json {
  // Depth 8 is not arbitrary: events -> [0] -> markets -> [0] -> outcomes ->
  // [0] -> fields is seven levels, and the outcome fields are the whole point.
  if (depth > maxDepth) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    // One representative element stands for the whole array.
    return [describeShape(value[0], depth + 1, maxDepth), `…${value.length} items`];
  }
  if (isObject(value)) {
    const shape: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value).slice(0, 40)) {
      shape[key] = describeShape(child, depth + 1, maxDepth);
    }
    return shape;
  }
  if (typeof value === "string") return Number.isFinite(Date.parse(value)) ? "string(date)" : "string";
  return typeof value;
}

export interface ShareableSummary {
  endpoints: {
    /** Query string values are stripped; parameter names are kept. */
    url: string;
    method: string;
    confidence: number;
    gameCount: number;
    headerNames: string[];
    mapping: FieldMapping;
    shape: Json;
    notes: string[];
  }[];
  htmlPages: { url: string; priceCount: number }[];
  entryCount: number;
}

/** Strip query *values*, keeping parameter names, which are often meaningful. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const keys = [...parsed.searchParams.keys()];
    parsed.search = "";
    // Assembled by hand: assigning to `search` would percent-encode the
    // placeholder and make the result harder to read than the original.
    return keys.length > 0
      ? `${parsed.toString()}?${keys.map((k) => `${k}=`).join("&")}`
      : parsed.toString();
  } catch {
    return url.split("?")[0];
  }
}

/**
 * A summary of a capture with nothing secret in it: no header values, no
 * cookies, no query values, and no response values — only structure.
 */
export function summarizeForSharing(har: unknown, limit = 3): ShareableSummary {
  const entries = (har as { log?: { entries?: HarEntry[] } })?.log?.entries ?? [];
  const sources = analyzeHar(har).slice(0, limit);

  const shapes = new Map<string, Json>();
  for (const entry of entries) {
    const url = entry.request?.url;
    const text = entry.response?.content?.text;
    if (!url || !text) continue;
    if (!sources.some((s) => s.url === url)) continue;
    try {
      shapes.set(url, describeShape(JSON.parse(text)));
    } catch {
      // Not parseable; analyzeHar would not have surfaced it anyway.
    }
  }

  return {
    endpoints: sources.map((source) => ({
      url: redactUrl(source.url),
      method: source.method,
      confidence: source.confidence,
      gameCount: source.gameCount,
      headerNames: source.authHeaders,
      mapping: source.mapping,
      shape: shapes.get(source.url) ?? "…",
      notes: source.notes,
    })),
    htmlPages: findHtmlCandidates(har)
      .slice(0, 3)
      .map((page) => ({ url: redactUrl(page.url), priceCount: page.priceCount })),
    entryCount: entries.length,
  };
}

/** A ready-to-paste CUSTOM_SOURCES entry for a discovered endpoint. */
export function toSourceConfig(source: DiscoveredSource, key = "mybookie") {
  return {
    key,
    title: key,
    url: source.url,
    headers: Object.fromEntries(
      source.authHeaders.map((name) => [name, `REPLACE_WITH_YOUR_${name.toUpperCase()}`]),
    ),
    sharp: false,
    ttlSeconds: 60,
    mapping: source.mapping,
  };
}
