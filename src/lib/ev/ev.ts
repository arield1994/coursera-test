/**
 * Expected value and stake sizing for a single offered price.
 */

import { decimalToAmerican, probabilityToDecimal } from "../odds/american";

export interface EvResult {
  /** Fair, vig-free probability the bet wins. */
  fairProbability: number;
  /** The price the bet *should* be at, in decimal and American form. */
  fairDecimal: number;
  fairAmerican: number;
  /** Expected profit per 1 unit staked. 0.043 = +4.3% EV. */
  edge: number;
  evPercent: number;
  /** Full-Kelly fraction of bankroll. Negative when the bet is -EV. */
  kellyFraction: number;
  /** Bankroll fraction after applying the user's Kelly multiplier. */
  stakeFraction: number;
  /** Currency stake, rounded to the nearest unit the user can actually place. */
  stake: number;
}

export interface StakeConfig {
  bankroll: number;
  /** 1 = full Kelly, 0.25 = quarter Kelly. Fractional Kelly is the norm. */
  kellyMultiplier: number;
  /** Never risk more than this share of bankroll on one bet, whatever Kelly says. */
  maxStakeFraction?: number;
}

export const DEFAULT_STAKE_CONFIG: StakeConfig = {
  bankroll: 1000,
  kellyMultiplier: 0.25,
  maxStakeFraction: 0.05,
};

/**
 * EV per unit staked is `p * (d - 1) - (1 - p)`, which simplifies to `p*d - 1`.
 *
 * Kelly's optimal fraction is `edge / (d - 1)` — the edge divided by the
 * amount won per unit risked. Full Kelly maximises long-run growth but assumes
 * your probability estimate is exact; since a devigged line is an *estimate*,
 * fractional Kelly is what anyone sane actually bets.
 */
export function computeEv(
  fairProbability: number,
  offeredDecimal: number,
  config: StakeConfig = DEFAULT_STAKE_CONFIG,
): EvResult | null {
  if (!Number.isFinite(fairProbability) || fairProbability <= 0 || fairProbability >= 1) {
    return null;
  }
  if (!Number.isFinite(offeredDecimal) || offeredDecimal <= 1) return null;

  const edge = fairProbability * offeredDecimal - 1;
  const kellyFraction = edge / (offeredDecimal - 1);

  const cap = config.maxStakeFraction ?? 1;
  const stakeFraction = Math.max(
    0,
    Math.min(kellyFraction * config.kellyMultiplier, cap),
  );

  const fairDecimal = probabilityToDecimal(fairProbability);

  return {
    fairProbability,
    fairDecimal,
    fairAmerican: decimalToAmerican(fairDecimal),
    edge,
    evPercent: edge * 100,
    kellyFraction,
    stakeFraction,
    stake: Math.round(stakeFraction * config.bankroll * 100) / 100,
  };
}

/**
 * Closing line value: how much better your price was than the closing price.
 *
 * CLV is the only feedback loop that works on a sample smaller than a season.
 * Whether a bet *won* is mostly noise; whether you consistently beat the close
 * is the actual measure of whether the edge was real.
 */
export function closingLineValue(betDecimal: number, closingDecimal: number): number | null {
  if (!Number.isFinite(betDecimal) || !Number.isFinite(closingDecimal)) return null;
  if (betDecimal <= 1 || closingDecimal <= 1) return null;
  return (betDecimal / closingDecimal - 1) * 100;
}

/** Profit (not return) of a settled bet, in currency. */
export function settledProfit(
  stake: number,
  decimal: number,
  result: "won" | "lost" | "push" | "void",
): number {
  switch (result) {
    case "won":
      return stake * (decimal - 1);
    case "lost":
      return -stake;
    default:
      return 0;
  }
}
