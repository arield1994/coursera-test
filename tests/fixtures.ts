import type { BookMarket, GameEvent, Outcome } from "../src/lib/odds/types";
import { americanToDecimal } from "../src/lib/odds/american";

export const HOUR = 3_600_000;

export function market(
  bookmaker: string,
  marketKey: string,
  outcomes: (Outcome & { american?: number })[],
): BookMarket {
  return {
    bookmaker,
    bookmakerTitle: bookmaker,
    marketKey,
    lastUpdate: new Date().toISOString(),
    outcomes: outcomes.map((o) => ({
      name: o.name,
      price: o.american !== undefined ? americanToDecimal(o.american) : o.price,
      point: o.point,
      description: o.description,
    })),
  };
}

export function event(
  markets: BookMarket[],
  overrides: Partial<GameEvent> = {},
): GameEvent {
  return {
    id: "evt-1",
    sportKey: "americanfootball_nfl",
    sportTitle: "NFL",
    commenceTime: new Date(Date.now() + 6 * HOUR).toISOString(),
    homeTeam: "Chiefs",
    awayTeam: "Bills",
    markets,
    ...overrides,
  };
}

/** Pinnacle at -110 both ways: a perfectly balanced 50/50 reference market. */
export function balancedPinnacleMoneyline(): BookMarket {
  return market("pinnacle", "h2h", [
    { name: "Chiefs", price: 0, american: -110 },
    { name: "Bills", price: 0, american: -110 },
  ]);
}
