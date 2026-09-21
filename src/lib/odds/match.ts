/**
 * Matching outside lines onto the games we already know about.
 *
 * A private bookie API or a scraper will not use the same team strings as the
 * main feed: "LA Lakers", "L.A. Lakers" and "Los Angeles Lakers" are one team,
 * and a line attached to the wrong game is worse than no line at all — it
 * produces a confident, completely fictitious edge.
 *
 * So matching here is deliberately conservative. It would rather drop a line
 * than guess: a candidate must clear a similarity threshold *and* be an
 * unambiguous winner over the runner-up before anything is attached.
 */

import type { GameEvent } from "./types";

/** Tokens that carry no identifying information in team names. */
const NOISE_TOKENS = new Set([
  "fc", "cf", "sc", "afc", "ac", "club", "the", "of",
]);

/**
 * Abbreviations worth expanding. Kept small and unambiguous on purpose — a
 * loose alias table is how "New York Jets" ends up matching "New York Giants".
 */
const ALIASES: Record<string, string> = {
  la: "los angeles",
  lac: "los angeles",
  lal: "los angeles",
  ny: "new york",
  nyc: "new york",
  sf: "san francisco",
  sd: "san diego",
  tb: "tampa bay",
  gb: "green bay",
  kc: "kansas city",
  ne: "new england",
  no: "new orleans",
  st: "saint",
  ste: "saint",
  mt: "mount",
  utd: "united",
  man: "manchester",
  wolves: "wolverhampton",
  spurs: "tottenham",
};

/** Lowercase, strip accents and punctuation, expand aliases, drop noise. */
export function normalizeTeam(name: string): string {
  return tokenizeTeam(name).join(" ");
}

export function tokenizeTeam(name: string): string[] {
  const cleaned = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Periods are dropped rather than turned into spaces so initialisms stay
    // whole: "L.A. Lakers" must become "la lakers", not "l a lakers".
    .replace(/\./g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const raw = cleaned.split(" ").filter(Boolean);

  // Join runs of single letters back into one token, so a source that writes
  // "L A Lakers" lands on the same alias as "LA Lakers".
  const merged: string[] = [];
  for (const token of raw) {
    if (token.length === 1 && merged.length > 0 && merged[merged.length - 1].length <= 2) {
      merged[merged.length - 1] += token;
    } else {
      merged.push(token);
    }
  }

  const tokens: string[] = [];
  for (const token of merged) {
    const expanded = ALIASES[token];
    if (expanded) tokens.push(...expanded.split(" "));
    else tokens.push(token);
  }
  return tokens.filter((t) => !NOISE_TOKENS.has(t));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) if (!b.has(token)) return false;
  return true;
}

/**
 * Similarity of two team names in [0, 1].
 *
 * The nickname rule ("Lakers" vs "Los Angeles Lakers") is what makes scraped
 * names usable at all, but it is also the riskiest, so it scores below an
 * outright containment match and well below an exact one.
 */
export function teamSimilarity(a: string, b: string): number {
  const tokensA = tokenizeTeam(a);
  const tokensB = tokenizeTeam(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  if (tokensA.join(" ") === tokensB.join(" ")) return 1;
  if (isSubset(setA, setB) || isSubset(setB, setA)) return 0.92;

  // Nicknames are usually the final token: "…Lakers", "…United".
  const nicknameMatch = tokensA[tokensA.length - 1] === tokensB[tokensB.length - 1];
  return Math.max(jaccard(setA, setB), nicknameMatch ? 0.85 : 0);
}

export interface EventCandidate {
  homeTeam: string;
  awayTeam: string;
  /** ISO timestamp. Optional — some scrapers only give a date. */
  commenceTime?: string;
  /** Optional; when present it must agree with the event's sport. */
  sportKey?: string;
}

export interface MatchOptions {
  /** Minimum mean team similarity to accept a match. */
  threshold: number;
  /**
   * How far apart two sources' scheduled start times may be. Sources disagree
   * by minutes routinely; hours apart usually means a different fixture.
   */
  toleranceMs: number;
  /**
   * A match must beat the runner-up by this much. Without it "United" would
   * attach to whichever of Manchester/Newcastle United happened to sort first.
   */
  minMargin: number;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  threshold: 0.8,
  toleranceMs: 6 * 3_600_000,
  minMargin: 0.05,
};

export interface EventMatch {
  event: GameEvent;
  score: number;
  /** True when the source lists the teams the other way round. */
  flipped: boolean;
}

function scoreAgainst(candidate: EventCandidate, event: GameEvent) {
  const direct =
    (teamSimilarity(candidate.homeTeam, event.homeTeam) +
      teamSimilarity(candidate.awayTeam, event.awayTeam)) /
    2;
  const flipped =
    (teamSimilarity(candidate.homeTeam, event.awayTeam) +
      teamSimilarity(candidate.awayTeam, event.homeTeam)) /
    2;
  return flipped > direct
    ? { score: flipped, flipped: true }
    : { score: direct, flipped: false };
}

/**
 * Best event for a candidate, or null when nothing is clearly right.
 *
 * Returning null is a normal outcome, not an error: an unmatched line is simply
 * dropped, and the ingest endpoint reports how many were dropped so a
 * misconfigured scraper is visible rather than silent.
 */
export function matchEvent(
  candidate: EventCandidate,
  events: GameEvent[],
  overrides: Partial<MatchOptions> = {},
): EventMatch | null {
  const options = { ...DEFAULT_MATCH_OPTIONS, ...overrides };
  const candidateTime = candidate.commenceTime
    ? Date.parse(candidate.commenceTime)
    : Number.NaN;

  const scored: EventMatch[] = [];

  for (const event of events) {
    if (candidate.sportKey && event.sportKey && candidate.sportKey !== event.sportKey) {
      continue;
    }
    if (Number.isFinite(candidateTime)) {
      const eventTime = Date.parse(event.commenceTime);
      if (
        Number.isFinite(eventTime) &&
        Math.abs(eventTime - candidateTime) > options.toleranceMs
      ) {
        continue;
      }
    }

    const { score, flipped } = scoreAgainst(candidate, event);
    if (score >= options.threshold) scored.push({ event, score, flipped });
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const [best, runnerUp] = scored;

  // Two plausible games means we cannot tell which one this line belongs to.
  if (runnerUp && best.score - runnerUp.score < options.minMargin) return null;

  return best;
}

/**
 * Rewrite an outcome's team name to the canonical one used by the matched
 * event.
 *
 * Without this a scraped "LA Lakers" outcome would never group with the feed's
 * "Los Angeles Lakers" outcome, and the custom book's price would sit in a
 * market of its own with nothing to compare it against.
 */
export function canonicalizeOutcomeName(
  name: string,
  event: GameEvent,
  threshold = 0.8,
): string {
  const home = teamSimilarity(name, event.homeTeam);
  const away = teamSimilarity(name, event.awayTeam);

  if (home >= threshold && home > away) return event.homeTeam;
  if (away >= threshold && away > home) return event.awayTeam;
  // Over / Under / Draw / a player name — leave it alone.
  return name;
}
