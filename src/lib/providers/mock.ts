/**
 * Deterministic synthetic odds feed.
 *
 * The site has to be usable — and testable — without an API key, so this
 * generates a board that behaves like a real one rather than random numbers:
 *
 *   - Each game has a hidden "true" probability. Books price *around* it.
 *   - Sharp books post a thin margin and little noise; soft books post a fat
 *     margin and a per-book opinion that drifts from true.
 *   - Margin is applied with a favourite-longshot skew, so the de-vig methods
 *     genuinely disagree instead of all recovering the same answer.
 *   - Prices are rounded to real American increments, which is where a
 *     surprising share of live edges actually comes from.
 *
 * Everything is driven by a seeded PRNG, so the same seed yields the same board.
 */

import type { GameEvent, BookMarket, Outcome, Sport } from "../odds/types";
import { BOOKS, bookProfile } from "../odds/books";
import { americanToDecimal, decimalToAmerican } from "../odds/american";
import type { OddsProvider } from "./types";

/** mulberry32 — small, fast, good enough for fixtures. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Box-Muller, for book opinions that cluster near true rather than spread flat. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface LeagueSpec {
  key: string;
  title: string;
  group: string;
  teams: string[];
  /** Typical combined score, used to place totals at a plausible number. */
  totalCenter: number;
  totalSpread: number;
  /** Typical spread magnitude. */
  handicapScale: number;
  /**
   * How much win probability one unit of line movement is worth. A point of
   * NFL total barely matters; a goal of EPL total is enormous. Without this a
   * book hanging a different number would be mispriced rather than merely
   * different.
   */
  lineSensitivity: number;
  hasDraw: boolean;
}

const LEAGUES: LeagueSpec[] = [
  {
    key: "americanfootball_nfl",
    title: "NFL",
    group: "American Football",
    totalCenter: 44.5,
    totalSpread: 7,
    handicapScale: 6,
    lineSensitivity: 0.026,
    hasDraw: false,
    teams: [
      "Kansas City Chiefs", "Buffalo Bills", "Philadelphia Eagles", "San Francisco 49ers",
      "Baltimore Ravens", "Detroit Lions", "Dallas Cowboys", "Miami Dolphins",
      "Green Bay Packers", "Cincinnati Bengals", "Houston Texans", "Los Angeles Rams",
    ],
  },
  {
    key: "basketball_nba",
    title: "NBA",
    group: "Basketball",
    totalCenter: 224.5,
    totalSpread: 12,
    handicapScale: 7,
    lineSensitivity: 0.019,
    hasDraw: false,
    teams: [
      "Boston Celtics", "Denver Nuggets", "Oklahoma City Thunder", "Minnesota Timberwolves",
      "New York Knicks", "Dallas Mavericks", "Milwaukee Bucks", "Phoenix Suns",
      "Los Angeles Lakers", "Philadelphia 76ers", "Cleveland Cavaliers", "Orlando Magic",
    ],
  },
  {
    key: "baseball_mlb",
    title: "MLB",
    group: "Baseball",
    totalCenter: 8.5,
    totalSpread: 1.5,
    handicapScale: 1.5,
    lineSensitivity: 0.105,
    hasDraw: false,
    teams: [
      "Los Angeles Dodgers", "Atlanta Braves", "Houston Astros", "New York Yankees",
      "Philadelphia Phillies", "Baltimore Orioles", "Texas Rangers", "Seattle Mariners",
      "Milwaukee Brewers", "San Diego Padres", "Cleveland Guardians", "Minnesota Twins",
    ],
  },
  {
    key: "icehockey_nhl",
    title: "NHL",
    group: "Ice Hockey",
    totalCenter: 6.5,
    totalSpread: 0.75,
    handicapScale: 1.5,
    lineSensitivity: 0.17,
    hasDraw: false,
    teams: [
      "Florida Panthers", "Edmonton Oilers", "Colorado Avalanche", "New York Rangers",
      "Carolina Hurricanes", "Dallas Stars", "Vegas Golden Knights", "Toronto Maple Leafs",
      "Boston Bruins", "Tampa Bay Lightning", "Vancouver Canucks", "Winnipeg Jets",
    ],
  },
  {
    key: "soccer_epl",
    title: "EPL",
    group: "Soccer",
    totalCenter: 2.5,
    totalSpread: 0.5,
    handicapScale: 1,
    lineSensitivity: 0.26,
    hasDraw: true,
    teams: [
      "Manchester City", "Arsenal", "Liverpool", "Aston Villa",
      "Tottenham Hotspur", "Chelsea", "Newcastle United", "Manchester United",
      "Brighton", "West Ham United", "Crystal Palace", "Brentford",
    ],
  },
];

export const MOCK_SPORTS: Sport[] = LEAGUES.map((l) => ({
  key: l.key,
  group: l.group,
  title: l.title,
  active: true,
}));

/** Round a decimal price to the nearest real-world American increment. */
function roundToMarketPrice(decimal: number): number {
  const american = decimalToAmerican(decimal);
  if (!Number.isFinite(american)) return decimal;
  const magnitude = Math.abs(american);
  // Books quote tighter increments near even money and coarser on longshots.
  const step = magnitude < 200 ? 5 : magnitude < 600 ? 10 : 25;
  const rounded = Math.sign(american) * Math.max(100, Math.round(magnitude / step) * step);
  return americanToDecimal(rounded);
}

/**
 * Turn a book's private fair view into posted prices.
 *
 * `skew` below 1 loads more of the margin onto longshots, which is what real
 * books do and what makes multiplicative de-vigging optimistic.
 */
function postPrices(fair: number[], vig: number, skew: number): number[] {
  const skewed = fair.map((p) => Math.pow(p, skew));
  const total = skewed.reduce((s, p) => s + p, 0);
  return skewed.map((p) => roundToMarketPrice(1 / ((p / total) * (1 + vig))));
}

/** Jitter a probability vector to represent one book's opinion, then renormalise. */
function bookOpinion(fair: number[], noise: number, rng: () => number): number[] {
  const shifted = fair.map((p) => Math.max(1e-4, p * Math.exp(gaussian(rng) * noise)));
  const total = shifted.reduce((s, p) => s + p, 0);
  return shifted.map((p) => p / total);
}

interface BuiltMarket {
  key: string;
  /**
   * The market as it would be priced at a given line offset. Books do not all
   * hang the same number, and a book on a different number is offering a
   * different bet — not a mispriced version of the same one.
   */
  at: (delta: number) => { sides: { name: string; point?: number }[]; fair: number[] };
  /** Moneylines have no number to disagree about. */
  shiftable: boolean;
}

function clampProbability(p: number): number {
  return Math.min(0.97, Math.max(0.03, p));
}

function buildEventMarkets(league: LeagueSpec, rng: () => number): BuiltMarket[] {
  const markets: BuiltMarket[] = [];

  // Moneyline. Home edge is baked in via a positive mean on the logit.
  const homeStrength = gaussian(rng) * 0.6 + 0.15;
  const drawShare = league.hasDraw ? 0.24 + rng() * 0.06 : 0;
  const homeRaw = 1 / (1 + Math.exp(-homeStrength));
  const h2hFair = league.hasDraw
    ? [homeRaw * (1 - drawShare), drawShare, (1 - homeRaw) * (1 - drawShare)]
    : [homeRaw, 1 - homeRaw];

  markets.push({
    key: "h2h",
    shiftable: false,
    at: () => ({
      sides: league.hasDraw
        ? [{ name: "HOME" }, { name: "Draw" }, { name: "AWAY" }]
        : [{ name: "HOME" }, { name: "AWAY" }],
      fair: h2hFair,
    }),
  });

  // Spread, placed near the number that makes the game a coin flip. Giving the
  // favourite more points lowers its cover probability, hence the sign.
  const handicapRaw = (homeRaw - 0.5) * league.handicapScale * 2;
  const handicap = -Math.round(handicapRaw * 2) / 2 || -0.5;
  const spreadHome = 0.5 + gaussian(rng) * 0.02;

  markets.push({
    key: "spreads",
    shiftable: true,
    at: (delta) => {
      const point = handicap + delta;
      const home = clampProbability(spreadHome + delta * league.lineSensitivity);
      return {
        sides: [
          { name: "HOME", point },
          { name: "AWAY", point: -point },
        ],
        fair: [home, 1 - home],
      };
    },
  });

  // Total. Raising the number makes the over less likely.
  const totalLine =
    Math.round((league.totalCenter + gaussian(rng) * league.totalSpread) * 2) / 2;
  const overProb = 0.5 + gaussian(rng) * 0.02;

  markets.push({
    key: "totals",
    shiftable: true,
    at: (delta) => {
      const over = clampProbability(overProb - delta * league.lineSensitivity);
      return {
        sides: [
          { name: "Over", point: totalLine + delta },
          { name: "Under", point: totalLine + delta },
        ],
        fair: [over, 1 - over],
      };
    },
  });

  return markets;
}

/**
 * How far this book's number sits from the market's. Sharp books cluster on the
 * consensus number; soft books drift, which is what creates middles and what
 * the EV scanner must refuse to price across.
 */
function lineOffset(sharp: boolean, rng: () => number): number {
  const roll = rng();
  if (sharp) return roll < 0.94 ? 0 : roll < 0.98 ? 0.5 : -0.5;
  if (roll < 0.72) return 0;
  if (roll < 0.84) return 0.5;
  if (roll < 0.96) return -0.5;
  return roll < 0.98 ? 1 : -1;
}

export interface MockOptions {
  seed?: number;
  eventsPerLeague?: number;
  now?: number;
}

export function generateMockEvents(options: MockOptions = {}): GameEvent[] {
  const { seed = 20260921, eventsPerLeague = 6, now = Date.now() } = options;
  const events: GameEvent[] = [];

  for (const league of LEAGUES) {
    for (let i = 0; i < eventsPerLeague; i++) {
      const rng = makeRng(hashString(`${seed}:${league.key}:${i}`));

      const homeIndex = Math.floor(rng() * league.teams.length);
      let awayIndex = Math.floor(rng() * league.teams.length);
      if (awayIndex === homeIndex) awayIndex = (awayIndex + 1) % league.teams.length;
      const homeTeam = league.teams[homeIndex];
      const awayTeam = league.teams[awayIndex];

      // Spread kickoffs from ~90 minutes out to a week, so the "starting soon"
      // and horizon filters both have something to act on.
      const commence = new Date(
        now + 90 * 60_000 + Math.floor(rng() * 7 * 24 * 60) * 60_000,
      ).toISOString();

      const built = buildEventMarkets(league, rng);
      const markets: BookMarket[] = [];

      for (const book of BOOKS) {
        const profile = bookProfile(book.key);
        // Not every book prices every game.
        if (rng() > (profile.sharp ? 0.95 : 0.82)) continue;

        // Soft books track the sharp line closely -- they are not stupid, they
        // are just slower and greedier. Most of a real board's edge comes from
        // staleness and price rounding, not from a book holding a wildly
        // different opinion, so this noise stays small on purpose.
        const noise = profile.sharp ? 0.008 : 0.012;
        const vigBase = profile.sharp ? 0.022 : 0.045;
        const skew = profile.sharp ? 0.985 : 0.94;

        for (const market of built) {
          if (!profile.sharp && market.key !== "h2h" && rng() > 0.88) continue;

          const delta = market.shiftable ? lineOffset(profile.sharp, rng) : 0;
          const { sides, fair } = market.at(delta);

          const opinion = bookOpinion(fair, noise, rng);
          const vig = vigBase + rng() * 0.012;
          let prices = postPrices(opinion, vig, skew);

          // Occasionally a soft book leaves one side stale or over-promotes it.
          // This is the thing the scanner exists to find.
          if (!profile.sharp) {
            const roll = rng();
            // Most staleness is small: the book is a step behind a line that
            // moved. Occasionally one is genuinely dead -- a number left up
            // after news the market already priced in. Those are the rows a
            // scanner must flag rather than celebrate, so the demo board needs
            // a few of them.
            const boost =
              roll < 0.0025
                ? 0.09 + rng() * 0.09
                : roll < 0.055
                  ? 0.02 + rng() * 0.05
                  : 0;
            if (boost > 0) {
              const side = Math.floor(rng() * prices.length);
              prices = prices.map((p, idx) =>
                idx === side ? roundToMarketPrice(p * (1 + boost)) : p,
              );
            }
          }

          const outcomes: Outcome[] = sides.map((side, idx) => ({
            name:
              side.name === "HOME" ? homeTeam : side.name === "AWAY" ? awayTeam : side.name,
            price: prices[idx],
            point: side.point,
          }));

          markets.push({
            bookmaker: profile.key,
            bookmakerTitle: profile.title,
            marketKey: market.key,
            lastUpdate: new Date(now - Math.floor(rng() * 240) * 1000).toISOString(),
            outcomes,
          });
        }
      }

      events.push({
        id: `mock-${league.key}-${i}`,
        sportKey: league.key,
        sportTitle: league.title,
        commenceTime: commence,
        homeTeam,
        awayTeam,
        markets,
      });
    }
  }

  return events;
}

export class MockProvider implements OddsProvider {
  readonly name = "demo";
  readonly isDemo = true;

  constructor(private readonly options: MockOptions = {}) {}

  async listSports(): Promise<Sport[]> {
    return MOCK_SPORTS;
  }

  async fetchOdds({
    sportKeys,
    marketKeys,
  }: {
    sportKeys: string[];
    marketKeys: string[];
  }): Promise<GameEvent[]> {
    const sportFilter = new Set(sportKeys);
    const marketFilter = new Set(marketKeys);

    return generateMockEvents(this.options)
      .filter((e) => sportFilter.size === 0 || sportFilter.has(e.sportKey))
      .map((e) => ({
        ...e,
        markets:
          marketFilter.size === 0
            ? e.markets
            : e.markets.filter((m) => marketFilter.has(m.marketKey)),
      }))
      .filter((e) => e.markets.length > 0);
  }
}
