/**
 * Fold externally-supplied lines into the board fetched from the main feed.
 *
 * Every custom price has to end up on the *right* game and under the *same*
 * outcome names as the rest of the feed, or it sits in a market of its own and
 * the scanner has nothing to compare it against. That is what the matching and
 * canonicalisation here is for.
 */

import type { GameEvent, BookMarket, Outcome } from "../odds/types";
import { canonicalizeOutcomeName, matchEvent, type MatchOptions } from "../odds/match";
import type { StoredSource } from "./store";
import type { NormalizedLine } from "./types";

export interface MergeStats {
  book: string;
  matched: number;
  unmatched: number;
  created: number;
}

export interface MergeResult {
  events: GameEvent[];
  stats: MergeStats[];
}

function toBookMarket(
  source: StoredSource,
  line: NormalizedLine,
  event: GameEvent | null,
  receivedAt: number,
): BookMarket {
  const outcomes: Outcome[] = line.outcomes.map((outcome) => ({
    // Rewrite "LA Lakers" to whatever the feed calls that team, so this price
    // groups with the others instead of forming a market of one.
    name: event ? canonicalizeOutcomeName(outcome.name, event) : outcome.name,
    price: outcome.decimal,
    point: outcome.point,
    description: outcome.description,
  }));

  return {
    bookmaker: source.book.key,
    bookmakerTitle: source.book.title,
    marketKey: line.marketKey,
    lastUpdate: new Date(receivedAt).toISOString(),
    outcomes,
  };
}

/**
 * Attach every active source's lines to a copy of the board.
 *
 * The input events come from a shared cache, so they are cloned rather than
 * mutated — appending in place would accumulate the same custom markets again
 * on every request until the cache expired.
 */
export function attachCustomLines(
  events: GameEvent[],
  sources: StoredSource[],
  matchOptions: Partial<MatchOptions> = {},
): MergeResult {
  if (sources.length === 0) return { events, stats: [] };

  const cloned: GameEvent[] = events.map((event) => ({
    ...event,
    markets: [...event.markets],
  }));
  const byId = new Map(cloned.map((event) => [event.id, event]));
  const stats: MergeStats[] = [];

  for (const source of sources) {
    let matched = 0;
    let unmatched = 0;
    let created = 0;

    for (const line of source.lines) {
      const hit = matchEvent(
        {
          homeTeam: line.home,
          awayTeam: line.away,
          commenceTime: line.commenceTime,
          sportKey: line.sportKey,
        },
        cloned,
        matchOptions,
      );

      if (hit) {
        const target = byId.get(hit.event.id);
        if (!target) continue;
        target.markets.push(toBookMarket(source, line, target, source.receivedAt));
        matched++;
        continue;
      }

      unmatched++;

      if (!source.createMissingEvents) continue;
      // A private book may carry games the main feed does not. These get an
      // event of their own; with no sharp book pricing them they will never
      // produce a fair line, so they show on the odds screen and stay out of
      // the +EV board, which is the correct outcome.
      if (!line.commenceTime) continue;

      const id = `custom-${source.book.key}-${slug(line.away)}-${slug(line.home)}-${line.commenceTime}`;
      let event = byId.get(id);
      if (!event) {
        event = {
          id,
          sportKey: line.sportKey ?? "custom",
          sportTitle: line.sportKey ?? source.book.title,
          commenceTime: line.commenceTime,
          homeTeam: line.home,
          awayTeam: line.away,
          markets: [],
        };
        byId.set(id, event);
        cloned.push(event);
        created++;
      }
      event.markets.push(toBookMarket(source, line, event, source.receivedAt));
    }

    stats.push({ book: source.book.key, matched, unmatched, created });
  }

  return { events: cloned, stats };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
