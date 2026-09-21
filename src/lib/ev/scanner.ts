/**
 * The +EV scanner.
 *
 * Pipeline, per market:
 *   1. Group every book's prices for the same market and the same line.
 *   2. De-vig each *sharp* book's complete market to fair probabilities.
 *   3. Blend those into one weighted consensus fair line.
 *   4. Price every other book's side against that consensus and keep the
 *      ones where the offered price pays more than fair.
 *
 * Two rules keep the output honest, and both cost us "opportunities":
 *   - A line is only ever compared to the *same* line. A +3.5 at one book is
 *     not a +3.5 market at another book that hung +4.5.
 *   - A market with no sharp reference is skipped entirely rather than
 *     devigged against the field, which would just measure who is softest.
 */

import { bookProfile } from "../odds/books";
import {
  type GameEvent,
  type BookMarket,
  type Outcome,
  marketGroupKey,
  marketLabel,
  outcomeKey,
  describeOutcome,
} from "../odds/types";
import { decimalToAmerican } from "../odds/american";
import { consensusProbabilities, devig, type DevigMethod } from "./devig";
import { computeEv, DEFAULT_STAKE_CONFIG, type StakeConfig } from "./ev";

export interface ScanOptions {
  devigMethod: DevigMethod;
  sharpBooks: string[];
  /** Books we are willing to actually bet at. Empty means "any soft book". */
  targetBooks: string[];
  marketKeys: string[];
  minEvPercent: number;
  /**
   * Edges above this are almost always a stale price, a mis-keyed line, or a
   * market the book has already pulled. They are surfaced but flagged.
   */
  suspiciousEvPercent: number;
  /** Hard ceiling — above this we drop the row entirely. */
  maxEvPercent: number;
  /** Require agreement from at least this many sharp books. */
  minSharpBooks: number;
  /** Drop events starting further out than this (0 = no limit). */
  maxHoursAhead: number;
  /** Include sharp books as bet targets too. */
  includeSharpAsTarget: boolean;
  stake: StakeConfig;
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  devigMethod: "worstCase",
  sharpBooks: ["pinnacle", "circasports", "betfair_ex_eu"],
  targetBooks: [],
  marketKeys: [],
  minEvPercent: 1,
  suspiciousEvPercent: 12,
  maxEvPercent: 40,
  minSharpBooks: 1,
  maxHoursAhead: 0,
  includeSharpAsTarget: false,
  stake: DEFAULT_STAKE_CONFIG,
};

export type OpportunityFlag = "stale-suspect" | "high-hold" | "thin-consensus" | "starting-soon";

export interface EvOpportunity {
  id: string;
  eventId: string;
  sportKey: string;
  sportTitle: string;
  commenceTime: string;
  matchup: string;
  homeTeam: string;
  awayTeam: string;

  marketKey: string;
  marketName: string;
  selection: string;
  outcomeKey: string;
  point?: number;

  book: string;
  bookTitle: string;
  decimal: number;
  american: number;
  lastUpdate: string;

  fairProbability: number;
  fairDecimal: number;
  fairAmerican: number;
  evPercent: number;
  kellyFraction: number;
  stakeFraction: number;
  stake: number;

  devigMethod: DevigMethod;
  sharpBooksUsed: string[];
  /** Mean overround of the sharp markets behind the fair line. */
  sharpHoldPercent: number;
  /** Best price on this exact side anywhere in the feed — for line shopping. */
  bestAvailableDecimal: number;
  bestAvailableBook: string;
  flags: OpportunityFlag[];
}

interface MarketGroup {
  event: GameEvent;
  key: string;
  marketKey: string;
  /** bookmaker key -> that book's prices for this market */
  byBook: Map<string, { market: BookMarket; outcomes: Outcome[] }>;
}

/**
 * Collect every book's prices for the same market+line into one group.
 *
 * A book can legitimately post the same market twice (alternate lines arrive as
 * separate outcomes); those land in separate groups because the line is part of
 * the group key.
 */
export function groupMarkets(events: GameEvent[]): MarketGroup[] {
  const groups = new Map<string, MarketGroup>();

  for (const event of events) {
    for (const market of event.markets) {
      for (const outcome of market.outcomes) {
        const key = `${event.id}|${marketGroupKey(market, outcome)}`;
        let group = groups.get(key);
        if (!group) {
          group = { event, key, marketKey: market.marketKey, byBook: new Map() };
          groups.set(key, group);
        }
        let entry = group.byBook.get(market.bookmaker);
        if (!entry) {
          entry = { market, outcomes: [] };
          group.byBook.set(market.bookmaker, entry);
        }
        entry.outcomes.push(outcome);
      }
    }
  }

  return [...groups.values()];
}

interface FairLine {
  probabilities: Map<string, number>;
  sharpBooksUsed: string[];
  meanOverround: number;
}

/**
 * Build the consensus fair line for one market group.
 *
 * Each sharp book is devigged on its own and only if it posted the *complete*
 * market — devigging a half-market (one side missing) is meaningless, so those
 * books are dropped rather than approximated.
 */
function buildFairLine(
  group: MarketGroup,
  options: ScanOptions,
): FairLine | null {
  const contributions: { probabilities: number[]; weight: number }[] = [];
  const used: string[] = [];
  const overrounds: number[] = [];
  let orderedKeys: string[] | null = null;
  // worstCase returns per-side lower bounds rather than a distribution; the
  // blend below must preserve that instead of normalising it away.
  let blendIsDistribution = true;

  for (const bookKey of options.sharpBooks) {
    const entry = group.byBook.get(bookKey);
    if (!entry || entry.outcomes.length < 2) continue;

    const keys = entry.outcomes.map(outcomeKey);
    // A book listing the same side twice means the feed is inconsistent for
    // this market; skip it rather than double-count a probability.
    if (new Set(keys).size !== keys.length) continue;

    if (orderedKeys === null) {
      orderedKeys = keys;
    } else if (
      keys.length !== orderedKeys.length ||
      !orderedKeys.every((k) => keys.includes(k))
    ) {
      // This book is pricing a different set of sides than the first sharp
      // book. Blending them would mix two different markets.
      continue;
    }

    const ordered = orderedKeys.map((k) => entry.outcomes[keys.indexOf(k)]);
    const result = devig(
      ordered.map((o) => o.price),
      options.devigMethod,
    );
    if (!result) continue;

    contributions.push({
      probabilities: result.probabilities,
      weight: bookProfile(bookKey).sharpWeight || 0.5,
    });
    blendIsDistribution &&= result.isDistribution;
    used.push(bookKey);
    overrounds.push(result.overround);
  }

  if (!orderedKeys || contributions.length < Math.max(1, options.minSharpBooks)) {
    return null;
  }

  const blended = consensusProbabilities(contributions, blendIsDistribution);
  if (!blended) return null;

  return {
    probabilities: new Map(orderedKeys.map((k, i) => [k, blended[i]])),
    sharpBooksUsed: used,
    meanOverround: overrounds.reduce((s, o) => s + o, 0) / overrounds.length,
  };
}

/** Best decimal price offered on each side, across every book in the group. */
function bestPrices(group: MarketGroup): Map<string, { decimal: number; book: string }> {
  const best = new Map<string, { decimal: number; book: string }>();
  for (const [bookKey, entry] of group.byBook) {
    for (const outcome of entry.outcomes) {
      const key = outcomeKey(outcome);
      const current = best.get(key);
      if (!current || outcome.price > current.decimal) {
        best.set(key, { decimal: outcome.price, book: bookKey });
      }
    }
  }
  return best;
}

export function scanForEv(
  events: GameEvent[],
  overrides: Partial<ScanOptions> = {},
): EvOpportunity[] {
  const options: ScanOptions = {
    ...DEFAULT_SCAN_OPTIONS,
    ...overrides,
    stake: { ...DEFAULT_SCAN_OPTIONS.stake, ...overrides.stake },
  };

  const now = Date.now();
  const horizon =
    options.maxHoursAhead > 0 ? now + options.maxHoursAhead * 3_600_000 : Infinity;
  const targetFilter = new Set(options.targetBooks);
  const marketFilter = new Set(options.marketKeys);

  const opportunities: EvOpportunity[] = [];

  for (const group of groupMarkets(events)) {
    if (marketFilter.size > 0 && !marketFilter.has(group.marketKey)) continue;

    const kickoff = Date.parse(group.event.commenceTime);
    // An event that has already started has no reliable pre-game fair line.
    if (Number.isFinite(kickoff) && (kickoff <= now || kickoff > horizon)) continue;

    const fair = buildFairLine(group, options);
    if (!fair) continue;

    const best = bestPrices(group);
    const sharpHoldPercent = (fair.meanOverround - 1) * 100;

    for (const [bookKey, entry] of group.byBook) {
      const profile = bookProfile(bookKey);
      if (profile.sharp && !options.includeSharpAsTarget) continue;
      if (targetFilter.size > 0 && !targetFilter.has(bookKey)) continue;

      for (const outcome of entry.outcomes) {
        const key = outcomeKey(outcome);
        const fairProbability = fair.probabilities.get(key);
        if (fairProbability === undefined) continue;

        const ev = computeEv(fairProbability, outcome.price, options.stake);
        if (!ev) continue;
        if (ev.evPercent < options.minEvPercent) continue;
        if (ev.evPercent > options.maxEvPercent) continue;

        const flags: OpportunityFlag[] = [];
        if (ev.evPercent >= options.suspiciousEvPercent) flags.push("stale-suspect");
        if (sharpHoldPercent > 4) flags.push("high-hold");
        if (fair.sharpBooksUsed.length < 2) flags.push("thin-consensus");
        if (Number.isFinite(kickoff) && kickoff - now < 15 * 60_000) {
          flags.push("starting-soon");
        }

        const bestForSide = best.get(key);

        opportunities.push({
          id: `${group.key}|${bookKey}|${key}`,
          eventId: group.event.id,
          sportKey: group.event.sportKey,
          sportTitle: group.event.sportTitle,
          commenceTime: group.event.commenceTime,
          matchup: `${group.event.awayTeam} @ ${group.event.homeTeam}`,
          homeTeam: group.event.homeTeam,
          awayTeam: group.event.awayTeam,

          marketKey: group.marketKey,
          marketName: marketLabel(group.marketKey),
          selection: describeOutcome(outcome),
          outcomeKey: key,
          point: outcome.point,

          book: bookKey,
          bookTitle: profile.title,
          decimal: outcome.price,
          american: decimalToAmerican(outcome.price),
          lastUpdate: entry.market.lastUpdate,

          fairProbability,
          fairDecimal: ev.fairDecimal,
          fairAmerican: ev.fairAmerican,
          evPercent: ev.evPercent,
          kellyFraction: ev.kellyFraction,
          stakeFraction: ev.stakeFraction,
          stake: ev.stake,

          devigMethod: options.devigMethod,
          sharpBooksUsed: fair.sharpBooksUsed,
          sharpHoldPercent,
          bestAvailableDecimal: bestForSide?.decimal ?? outcome.price,
          bestAvailableBook: bestForSide?.book ?? bookKey,
          flags,
        });
      }
    }
  }

  return opportunities.sort((a, b) => b.evPercent - a.evPercent);
}
