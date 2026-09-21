/**
 * Odds representation helpers.
 *
 * Internally every price is carried as *decimal* odds, because decimal odds
 * multiply cleanly (payout = stake * decimal) and convert to probability with a
 * single reciprocal. American odds are a display format and are converted at
 * the edges.
 */

/** Smallest decimal price we accept. 1.0 pays nothing back beyond the stake. */
const MIN_DECIMAL = 1.0000001;

export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || american === 0) return NaN;
  return american > 0 ? american / 100 + 1 : 100 / -american + 1;
}

export function decimalToAmerican(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) return NaN;
  return decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
}

/** Raw (vig-inclusive) implied probability of a single price. */
export function decimalToProbability(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) return NaN;
  return 1 / decimal;
}

export function probabilityToDecimal(probability: number): number {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return NaN;
  return 1 / probability;
}

export function probabilityToAmerican(probability: number): number {
  return decimalToAmerican(probabilityToDecimal(probability));
}

export function americanToProbability(american: number): number {
  return decimalToProbability(americanToDecimal(american));
}

/** Clamp a decimal price into a range we can do arithmetic on. */
export function sanitizeDecimal(decimal: number): number {
  if (!Number.isFinite(decimal)) return NaN;
  return Math.max(decimal, MIN_DECIMAL);
}

/** "+145" / "-110" — the format bettors actually read. */
export function formatAmerican(american: number): string {
  if (!Number.isFinite(american)) return "—";
  const rounded = Math.round(american);
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

export function formatDecimal(decimal: number): string {
  if (!Number.isFinite(decimal)) return "—";
  return decimal.toFixed(3);
}

/**
 * The total implied probability of a complete market. 1.0 is a fair book;
 * 1.045 means the book is holding 4.5 points of overround ("vig").
 */
export function overround(decimalPrices: number[]): number {
  return decimalPrices.reduce((sum, d) => sum + decimalToProbability(d), 0);
}

/** Overround expressed the way bettors quote it: the book's hold percentage. */
export function holdPercent(decimalPrices: number[]): number {
  const total = overround(decimalPrices);
  if (!Number.isFinite(total) || total <= 0) return NaN;
  return (1 - 1 / total) * 100;
}
