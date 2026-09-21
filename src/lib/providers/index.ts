import { MockProvider } from "./mock";
import { TheOddsApiProvider } from "./theOddsApi";
import type { OddsProvider } from "./types";

/**
 * Pick a provider from the environment.
 *
 * With no key configured the site runs on generated data rather than showing an
 * error page — a scanner you can't look at can't be evaluated. Every response
 * carries `demo: true` so the UI can say so plainly instead of passing
 * synthetic prices off as live ones.
 */
export function getProvider(): OddsProvider {
  const apiKey = process.env.ODDS_API_KEY?.trim();
  if (apiKey) return new TheOddsApiProvider(apiKey);
  return new MockProvider();
}

export const DEFAULT_SPORT_KEYS = [
  "americanfootball_nfl",
  "basketball_nba",
  "baseball_mlb",
  "icehockey_nhl",
  "soccer_epl",
];

export const DEFAULT_MARKET_KEYS = ["h2h", "spreads", "totals"];

/** How long a cached odds payload stays fresh. Live feeds move fast; quota doesn't. */
export const ODDS_TTL_MS = Number(process.env.ODDS_CACHE_TTL_MS ?? 30_000);

export { MockProvider, TheOddsApiProvider };
export type { OddsProvider };
