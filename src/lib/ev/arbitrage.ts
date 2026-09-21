/**
 * Arbitrage and middle detection.
 *
 * Arbitrage needs no probability model at all: if the best available prices on
 * every side of a market sum to less than 100% implied probability, the payout
 * is locked regardless of the result. That makes it the one output on this site
 * that does not depend on a de-vig assumption being right.
 */

import { bookProfile } from "../odds/books";
import { decimalToAmerican, decimalToProbability } from "../odds/american";
import {
  type GameEvent,
  describeOutcome,
  marketLabel,
  outcomeKey,
} from "../odds/types";
import { groupMarkets } from "./scanner";

export interface ArbLeg {
  selection: string;
  book: string;
  bookTitle: string;
  decimal: number;
  american: number;
  /** Share of the total bankroll for this arb that goes on this leg. */
  stakeFraction: number;
  stake: number;
}

export interface ArbOpportunity {
  id: string;
  eventId: string;
  sportKey: string;
  sportTitle: string;
  commenceTime: string;
  matchup: string;
  marketKey: string;
  marketName: string;
  /** Guaranteed return on total stake, as a percentage. */
  profitPercent: number;
  totalStake: number;
  guaranteedProfit: number;
  legs: ArbLeg[];
}

export interface ArbOptions {
  totalStake: number;
  minProfitPercent: number;
  maxProfitPercent: number;
  marketKeys: string[];
  books: string[];
  maxHoursAhead: number;
}

export const DEFAULT_ARB_OPTIONS: ArbOptions = {
  totalStake: 500,
  minProfitPercent: 0.25,
  // Anything this good is a stale line, not a gift.
  maxProfitPercent: 15,
  marketKeys: [],
  books: [],
  maxHoursAhead: 0,
};

export function findArbitrage(
  events: GameEvent[],
  overrides: Partial<ArbOptions> = {},
): ArbOpportunity[] {
  const options = { ...DEFAULT_ARB_OPTIONS, ...overrides };
  const now = Date.now();
  const horizon =
    options.maxHoursAhead > 0 ? now + options.maxHoursAhead * 3_600_000 : Infinity;
  const bookFilter = new Set(options.books);
  const marketFilter = new Set(options.marketKeys);

  const results: ArbOpportunity[] = [];

  for (const group of groupMarkets(events)) {
    if (marketFilter.size > 0 && !marketFilter.has(group.marketKey)) continue;

    const kickoff = Date.parse(group.event.commenceTime);
    if (Number.isFinite(kickoff) && (kickoff <= now || kickoff > horizon)) continue;

    // Establish the market's complete set of sides from a book that priced all
    // of them. Taking the union across books would happily "complete" a market
    // with two halves of two different lines.
    let sides: string[] | null = null;
    for (const [, entry] of group.byBook) {
      const keys = entry.outcomes.map(outcomeKey);
      if (keys.length >= 2 && new Set(keys).size === keys.length) {
        if (!sides || keys.length > sides.length) sides = keys;
      }
    }
    if (!sides) continue;

    // Best price per side across the books we're allowed to use.
    const best = new Map<
      string,
      { decimal: number; book: string; selection: string }
    >();
    for (const [bookKey, entry] of group.byBook) {
      if (bookFilter.size > 0 && !bookFilter.has(bookKey)) continue;
      for (const outcome of entry.outcomes) {
        const key = outcomeKey(outcome);
        const current = best.get(key);
        if (!current || outcome.price > current.decimal) {
          best.set(key, {
            decimal: outcome.price,
            book: bookKey,
            selection: describeOutcome(outcome),
          });
        }
      }
    }

    const picks = sides.map((s) => best.get(s));
    if (picks.some((p) => p === undefined)) continue;
    const chosen = picks as { decimal: number; book: string; selection: string }[];

    // Two legs at the same book is not an arbitrage — the book would simply
    // refuse or void it, and it usually means a duplicated feed entry.
    if (new Set(chosen.map((c) => c.book)).size < 2) continue;

    const impliedTotal = chosen.reduce((s, c) => s + decimalToProbability(c.decimal), 0);
    if (!Number.isFinite(impliedTotal) || impliedTotal >= 1) continue;

    const profitPercent = (1 / impliedTotal - 1) * 100;
    if (profitPercent < options.minProfitPercent) continue;
    if (profitPercent > options.maxProfitPercent) continue;

    const legs: ArbLeg[] = chosen.map((c) => {
      const stakeFraction = decimalToProbability(c.decimal) / impliedTotal;
      return {
        selection: c.selection,
        book: c.book,
        bookTitle: bookProfile(c.book).title,
        decimal: c.decimal,
        american: decimalToAmerican(c.decimal),
        stakeFraction,
        stake: Math.round(stakeFraction * options.totalStake * 100) / 100,
      };
    });

    results.push({
      id: group.key,
      eventId: group.event.id,
      sportKey: group.event.sportKey,
      sportTitle: group.event.sportTitle,
      commenceTime: group.event.commenceTime,
      matchup: `${group.event.awayTeam} @ ${group.event.homeTeam}`,
      marketKey: group.marketKey,
      marketName: marketLabel(group.marketKey),
      profitPercent,
      totalStake: options.totalStake,
      guaranteedProfit:
        Math.round(options.totalStake * (profitPercent / 100) * 100) / 100,
      legs,
    });
  }

  return results.sort((a, b) => b.profitPercent - a.profitPercent);
}

/* ------------------------------------------------------------------ */
/* Middles                                                             */
/* ------------------------------------------------------------------ */

export interface MiddleOpportunity {
  id: string;
  eventId: string;
  sportKey: string;
  sportTitle: string;
  commenceTime: string;
  matchup: string;
  marketKey: string;
  marketName: string;
  /** The window of results where *both* legs cash. */
  lowLine: number;
  highLine: number;
  /** Integer results strictly inside the window; 0.5 lines never push. */
  windowWidth: number;
  /** Cost of the middle as a percentage of stake if it misses (may be negative = free middle). */
  costPercent: number;
  /** Return if the middle hits, as a percentage of total stake. */
  hitReturnPercent: number;
  legs: ArbLeg[];
}

export interface MiddleOptions {
  totalStake: number;
  /** Reject middles that cost more than this much of the stake to hold. */
  maxCostPercent: number;
  minWindowWidth: number;
  maxHoursAhead: number;
}

export const DEFAULT_MIDDLE_OPTIONS: MiddleOptions = {
  totalStake: 500,
  maxCostPercent: 8,
  minWindowWidth: 0.5,
  maxHoursAhead: 0,
};

/**
 * A middle is two bets on opposite sides at *different* lines, arranged so a
 * result landing between them wins both. Unlike an arb it is not risk-free —
 * it normally costs a little to hold — but its payoff is far larger.
 *
 * Only two-sided lined markets can middle, so this walks totals and spreads
 * across every line a book has posted, which is exactly the comparison the EV
 * scanner deliberately refuses to make.
 */
export function findMiddles(
  events: GameEvent[],
  overrides: Partial<MiddleOptions> = {},
): MiddleOpportunity[] {
  const options = { ...DEFAULT_MIDDLE_OPTIONS, ...overrides };
  const now = Date.now();
  const horizon =
    options.maxHoursAhead > 0 ? now + options.maxHoursAhead * 3_600_000 : Infinity;

  const results: MiddleOpportunity[] = [];

  for (const event of events) {
    const kickoff = Date.parse(event.commenceTime);
    if (Number.isFinite(kickoff) && (kickoff <= now || kickoff > horizon)) continue;

    // marketKey -> side ("over"/"under") -> best price at each line
    const shelf = new Map<
      string,
      Map<string, Map<number, { decimal: number; book: string; selection: string }>>
    >();

    for (const market of event.markets) {
      const isTotal = market.marketKey.includes("total");
      const isSpread = market.marketKey.includes("spread");
      if (!isTotal && !isSpread) continue;

      for (const outcome of market.outcomes) {
        if (outcome.point === undefined) continue;
        const side = outcome.name.toLowerCase();

        let bySide = shelf.get(market.marketKey);
        if (!bySide) shelf.set(market.marketKey, (bySide = new Map()));
        let byLine = bySide.get(side);
        if (!byLine) bySide.set(side, (byLine = new Map()));

        const current = byLine.get(outcome.point);
        if (!current || outcome.price > current.decimal) {
          byLine.set(outcome.point, {
            decimal: outcome.price,
            book: market.bookmaker,
            selection: describeOutcome(outcome),
          });
        }
      }
    }

    for (const [marketKey, bySide] of shelf) {
      const sideNames = [...bySide.keys()];
      if (sideNames.length !== 2) continue;

      // "Under"/"away" is whichever side wins when the number comes in low.
      const lowSideName =
        sideNames.find((s) => s === "over") ?? sideNames[0];
      const highSideName = sideNames.find((s) => s !== lowSideName)!;
      const lowSide = bySide.get(lowSideName)!;
      const highSide = bySide.get(highSideName)!;

      for (const [lowLine, lowPick] of lowSide) {
        for (const [highLine, highPick] of highSide) {
          // Totals: Over L1 + Under L2 middles when L2 > L1.
          // Spreads: the two sides carry opposite signs, so compare magnitudes.
          const a = marketKey.includes("spread") ? -lowLine : lowLine;
          const b = marketKey.includes("spread") ? highLine : highLine;
          const width = b - a;
          if (width < options.minWindowWidth) continue;
          if (lowPick.book === highPick.book) continue;

          const implied =
            decimalToProbability(lowPick.decimal) + decimalToProbability(highPick.decimal);
          const costPercent = (1 - 1 / implied) * 100;
          if (costPercent > options.maxCostPercent) continue;

          const lowStakeFraction = decimalToProbability(lowPick.decimal) / implied;
          const highStakeFraction = 1 - lowStakeFraction;
          const hitReturnPercent =
            (lowStakeFraction * lowPick.decimal + highStakeFraction * highPick.decimal - 1) *
            100;

          results.push({
            id: `${event.id}|${marketKey}|${a}|${b}`,
            eventId: event.id,
            sportKey: event.sportKey,
            sportTitle: event.sportTitle,
            commenceTime: event.commenceTime,
            matchup: `${event.awayTeam} @ ${event.homeTeam}`,
            marketKey,
            marketName: marketLabel(marketKey),
            lowLine: a,
            highLine: b,
            windowWidth: width,
            costPercent,
            hitReturnPercent,
            legs: [lowPick, highPick].map((p, i) => {
              const stakeFraction = i === 0 ? lowStakeFraction : highStakeFraction;
              return {
                selection: p.selection,
                book: p.book,
                bookTitle: bookProfile(p.book).title,
                decimal: p.decimal,
                american: decimalToAmerican(p.decimal),
                stakeFraction,
                stake: Math.round(stakeFraction * options.totalStake * 100) / 100,
              };
            }),
          });
        }
      }
    }
  }

  return results.sort((a, b) => a.costPercent - b.costPercent);
}
