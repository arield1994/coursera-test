/**
 * De-vigging: recovering a market's *fair* probabilities from a bookmaker's
 * posted prices.
 *
 * A posted market always sums to more than 100% — the excess is the book's
 * margin. To judge whether a price elsewhere is +EV we first have to strip that
 * margin off a sharp book's line to get an unbiased probability estimate.
 *
 * There is no single correct way to do it, because we cannot observe *how* the
 * book distributed its margin across the outcomes. The methods below make
 * different assumptions, and they disagree most on longshots — which is exactly
 * where naive scanners manufacture fake edges. Supporting several methods (and
 * a conservative worst-case) is the point.
 */

import { decimalToProbability } from "../odds/american";

export const DEVIG_METHODS = [
  "multiplicative",
  "additive",
  "power",
  "shin",
  "worstCase",
] as const;

export type DevigMethod = (typeof DEVIG_METHODS)[number];

export const DEVIG_METHOD_LABELS: Record<DevigMethod, string> = {
  multiplicative: "Multiplicative",
  additive: "Additive",
  power: "Power",
  shin: "Shin",
  worstCase: "Worst case",
};

export const DEVIG_METHOD_BLURBS: Record<DevigMethod, string> = {
  multiplicative:
    "Scales every outcome by the same factor. Simple and stable, but assumes the book spreads its margin proportionally — which inflates longshot edges.",
  additive:
    "Removes an equal slice of probability from each outcome. Kinder to longshots, but can produce negative probabilities on lopsided markets.",
  power:
    "Raises each probability to a common exponent. A good middle ground; widely used for player props.",
  shin:
    "Models the margin as protection against insider money. Closest to observed closing-line behaviour on two-way markets.",
  worstCase:
    "Takes the least favourable fair probability across all methods. Fewer plays, but the edges that survive are real.",
};

export interface DevigResult {
  /** Fair, vig-free probabilities, index-aligned with the input prices. */
  probabilities: number[];
  /** Total implied probability before de-vigging (1.045 = 4.5 pts of overround). */
  overround: number;
  method: DevigMethod;
  /**
   * True when `probabilities` sums to 1. False for `worstCase`, which returns
   * an independent lower bound per side. Anything that needs a genuine
   * distribution (a consensus blend, a parlay) must check this.
   */
  isDistribution: boolean;
}

/** A market must have at least two outcomes and sum to more than 100% to be devigable. */
function rawProbabilities(decimalPrices: number[]): number[] | null {
  if (decimalPrices.length < 2) return null;
  const raw = decimalPrices.map(decimalToProbability);
  if (raw.some((p) => !Number.isFinite(p) || p <= 0 || p >= 1)) return null;
  return raw;
}

function normalize(probabilities: number[]): number[] {
  const total = probabilities.reduce((s, p) => s + p, 0);
  return probabilities.map((p) => p / total);
}

/** q_i = p_i / Σp */
function multiplicative(raw: number[]): number[] {
  return normalize(raw);
}

/**
 * q_i = p_i - (Σp - 1) / n
 *
 * Can drive a heavy longshot negative; when that happens the assumption has
 * broken down and we fall back rather than emit a nonsense probability.
 */
function additive(raw: number[]): number[] | null {
  const excess = raw.reduce((s, p) => s + p, 0) - 1;
  const share = excess / raw.length;
  const fair = raw.map((p) => p - share);
  if (fair.some((p) => p <= 0 || p >= 1)) return null;
  return fair;
}

/**
 * Solve Σ p_i^k = 1 for k, then q_i = p_i^k.
 *
 * Σ p_i^k is strictly decreasing in k for p_i in (0,1), and exceeds 1 at k = 1,
 * so a unique root k > 1 exists. Bisection is slower than Newton but cannot
 * diverge, which matters when a market contains a 1.01 favourite.
 */
function power(raw: number[]): number[] | null {
  const sumAt = (k: number) => raw.reduce((s, p) => s + Math.pow(p, k), 0);

  let lo = 1;
  let hi = 2;
  // Expand the bracket until the sum drops below 1. Heavy favourites decay
  // slowly, so the exponent can legitimately be large.
  let guard = 0;
  while (sumAt(hi) > 1) {
    lo = hi;
    hi *= 2;
    if (++guard > 60) return null;
  }

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid;
    else hi = mid;
  }

  const k = (lo + hi) / 2;
  const fair = raw.map((p) => Math.pow(p, k));
  if (fair.some((p) => !Number.isFinite(p) || p <= 0 || p >= 1)) return null;
  return normalize(fair);
}

/**
 * Shin (1993): the book's margin is treated as compensation for trading against
 * a proportion `z` of insiders. Given the posted probabilities p_i summing to
 * Sp, the fair probability of outcome i is
 *
 *   q_i = ( sqrt( z^2 + 4(1-z) * p_i^2 / Sp ) - z ) / ( 2(1-z) )
 *
 * with z chosen so the q_i sum to 1.
 *
 * Sum(q) is *decreasing* in z: it starts at sqrt(Sp) (above 1 for any market
 * with margin) and falls toward Sum(p^2)/Sp. So the bracket is [0, 1) and the
 * bisection moves the lower bound up when the sum is still above 1.
 *
 * Worth knowing: on a *two-outcome* market Shin's solution is algebraically
 * identical to the additive one, so choosing it over additive for a moneyline,
 * spread or total changes nothing. It only diverges on three-way markets such
 * as soccer 1X2, which is where it earns its keep.
 */
function shin(raw: number[]): number[] | null {
  const total = raw.reduce((s, p) => s + p, 0);

  const probsAt = (z: number) =>
    raw.map(
      (p) =>
        (Math.sqrt(z * z + (4 * (1 - z) * p * p) / total) - z) / (2 * (1 - z)),
    );
  const sumAt = (z: number) => probsAt(z).reduce((s, p) => s + p, 0);

  const lowBound = 0;
  const highBound = 0.999999;
  // No margin to strip, or the model cannot reach a fair distribution for this
  // market. Either way, defer to another method rather than return a guess.
  if (sumAt(lowBound) <= 1) return null;
  if (sumAt(highBound) >= 1) return null;

  let lo = lowBound;
  let hi = highBound;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid;
    else hi = mid;
  }

  const fair = probsAt((lo + hi) / 2);
  if (fair.some((p) => !Number.isFinite(p) || p <= 0 || p >= 1)) return null;
  return normalize(fair);
}

/**
 * The most pessimistic fair probability per outcome across every method that
 * converged. Lower fair probability means lower computed EV, so this is the
 * conservative read: an edge that survives worst-case de-vigging is not an
 * artefact of the method you happened to pick.
 *
 * Deliberately NOT normalised, and so it does not sum to 1. Each entry is a
 * lower bound on one side considered on its own; renormalising would scale
 * every bound back up and throw away the conservatism that is the entire
 * point. Consumers price one side at a time, so this is the right shape --
 * but it is a vector of bounds, not a probability distribution. `devig`
 * reports which one it returned via `isDistribution`.
 */
function worstCase(raw: number[]): number[] | null {
  const candidates = [multiplicative(raw), additive(raw), power(raw), shin(raw)].filter(
    (c): c is number[] => c !== null,
  );
  if (candidates.length === 0) return null;
  return raw.map((_, i) => Math.min(...candidates.map((c) => c[i])));
}

const IMPLEMENTATIONS: Record<DevigMethod, (raw: number[]) => number[] | null> = {
  multiplicative,
  additive,
  power,
  shin,
  worstCase,
};

/**
 * Strip the vig from a complete set of prices for one market.
 *
 * `decimalPrices` must cover *every* outcome of the market — a two-way total
 * needs both over and under. A partial market cannot be devigged and returns
 * null rather than a guess.
 *
 * Methods that fail to converge fall back to multiplicative, which always
 * produces a valid distribution.
 */
export function devig(
  decimalPrices: number[],
  method: DevigMethod = "worstCase",
): DevigResult | null {
  const raw = rawProbabilities(decimalPrices);
  if (!raw) return null;

  const total = raw.reduce((s, p) => s + p, 0);
  // A market that sums below 100% is an arbitrage, not a devig problem. The
  // normalisation below would *inflate* probabilities; the arbitrage scanner
  // handles that case instead.
  if (total <= 1) {
    return {
      probabilities: normalize(raw),
      overround: total,
      method,
      isDistribution: true,
    };
  }

  const computed = IMPLEMENTATIONS[method](raw);
  // A method that failed to converge falls back to multiplicative, which
  // always produces a valid distribution -- so the flag follows what we
  // actually returned, not what was asked for.
  const probabilities = computed ?? multiplicative(raw);
  return {
    probabilities,
    overround: total,
    method,
    isDistribution: method !== "worstCase" || computed === null,
  };
}

/**
 * Blend fair probabilities from several sharp books into one consensus estimate.
 *
 * Each book is devigged independently first -- averaging *posted* prices would
 * blend the books' margins into the estimate. Weights let a genuinely sharp
 * book outvote a merely-sharpish one.
 *
 * `renormalize` must be false when the inputs are `worstCase` bound-vectors.
 * Those sum to less than 1 on purpose; renormalising a blend of them would
 * scale every bound back up and quietly discard the conservatism -- which on a
 * typical market is worth ~2 points of phantom EV, enough to turn the whole
 * board green.
 */
export function consensusProbabilities(
  devigged: { probabilities: number[]; weight: number }[],
  renormalize = true,
): number[] | null {
  if (devigged.length === 0) return null;
  const width = devigged[0].probabilities.length;
  if (devigged.some((d) => d.probabilities.length !== width)) return null;

  const totalWeight = devigged.reduce((s, d) => s + d.weight, 0);
  if (totalWeight <= 0) return null;

  const blended = Array.from({ length: width }, (_, i) =>
    devigged.reduce((s, d) => s + d.probabilities[i] * d.weight, 0) / totalWeight,
  );
  return renormalize ? normalize(blended) : blended;
}
