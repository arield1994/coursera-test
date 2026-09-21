/**
 * The normalised odds model every provider is adapted into.
 *
 * Feed-specific shapes (The Odds API, a scraper, a fixture file) are converted
 * to these types at the provider boundary so the EV engine never has to know
 * where a price came from.
 */

export interface Outcome {
  /** "Over", "Under", or a team / player name. */
  name: string;
  /** Decimal odds. Always decimal internally; American is a display concern. */
  price: number;
  /** Handicap or total line. Absent for moneylines. */
  point?: number;
  /** Player name on a player prop; absent on team markets. */
  description?: string;
}

export interface BookMarket {
  /** Stable bookmaker slug, e.g. "pinnacle", "draftkings". */
  bookmaker: string;
  bookmakerTitle: string;
  /** Market slug, e.g. "h2h", "spreads", "totals", "player_points". */
  marketKey: string;
  /** ISO timestamp of the last price change we saw. */
  lastUpdate: string;
  outcomes: Outcome[];
}

export interface GameEvent {
  id: string;
  sportKey: string;
  sportTitle: string;
  /** ISO timestamp of kickoff / first pitch / tip-off. */
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  markets: BookMarket[];
}

export interface Sport {
  key: string;
  group: string;
  title: string;
  active: boolean;
}

export const MARKET_LABELS: Record<string, string> = {
  h2h: "Moneyline",
  spreads: "Spread",
  totals: "Total",
  outrights: "Outright",
  team_totals: "Team total",
  player_points: "Player points",
  player_rebounds: "Player rebounds",
  player_assists: "Player assists",
  player_pass_yds: "Passing yards",
  player_rush_yds: "Rushing yards",
  player_receptions: "Receptions",
  batter_hits: "Batter hits",
  pitcher_strikeouts: "Pitcher strikeouts",
  player_shots_on_goal: "Shots on goal",
};

export function marketLabel(key: string): string {
  return (
    MARKET_LABELS[key] ??
    key.replace(/^player_/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * Identifies one *side* of a market so the same side can be matched across
 * books. The line is part of the identity: "Over 45.5" and "Over 46.5" are
 * different bets and must never be compared to each other.
 */
export function outcomeKey(outcome: Outcome): string {
  const point = outcome.point === undefined ? "" : outcome.point.toFixed(2);
  return [outcome.description ?? "", outcome.name, point].join("|").toLowerCase();
}

/**
 * Identifies a whole market so all of its sides group together.
 *
 * Spreads are the awkward case: the two sides carry opposite handicaps
 * (-3.5 / +3.5) but are one market, so the magnitude is used. Totals share a
 * single line, and moneylines have none.
 */
export function marketGroupKey(market: BookMarket, outcome: Outcome): string {
  const parts: string[] = [market.marketKey];
  if (outcome.description) parts.push(outcome.description);
  if (outcome.point !== undefined) {
    const isTwoSidedHandicap = market.marketKey.includes("spread");
    parts.push((isTwoSidedHandicap ? Math.abs(outcome.point) : outcome.point).toFixed(2));
  }
  return parts.join("|").toLowerCase();
}

/**
 * Human label for a side, e.g. "Over 45.5" or "Lakers -3.5".
 *
 * The explicit "+" belongs on a handicap, where the sign is the bet: "Lakers
 * +3.5" and "Lakers -3.5" are opposite sides. On a total the number is just a
 * threshold, so "Over +45.5" is noise that reads like a price.
 */
export function describeOutcome(outcome: Outcome, marketKey?: string): string {
  const signed = marketKey === undefined || marketKey.includes("spread");
  const point =
    outcome.point === undefined
      ? ""
      : ` ${signed && outcome.point > 0 ? "+" : ""}${outcome.point}`;
  const player = outcome.description ? `${outcome.description} ` : "";
  return `${player}${outcome.name}${point}`.trim();
}
