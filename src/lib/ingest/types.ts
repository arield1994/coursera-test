/**
 * The payload a private bookie API adapter or a scraper posts to /api/ingest.
 *
 * Deliberately forgiving about *format* and strict about *values*. A scraper
 * author should not have to convert odds or canonicalise team names to get
 * started — but a price of 0, a market with one side, or a game nobody can
 * identify must be rejected loudly rather than quietly becoming a fake edge.
 *
 * Validation is hand-rolled rather than pulled from a schema library: the
 * shape is small, and the per-line error messages are the actual product here.
 * "line 3: outcome 'Over' has no usable price" is what makes a scraper
 * debuggable at 2am.
 */

import { americanToDecimal } from "../odds/american";

export interface IngestBook {
  /** Stable slug. Becomes the bookmaker key throughout the app. */
  key: string;
  title?: string;
  /**
   * Whether this book may help define the fair line. Defaults to false --
   * an unproven private source should not get to decide what a price *should*
   * be until you have reason to trust it.
   */
  sharp?: boolean;
  sharpWeight?: number;
}

export interface IngestOutcome {
  name: string;
  /** Supply exactly one of these. */
  american?: number;
  decimal?: number;
  point?: number;
  description?: string;
}

export interface IngestLine {
  sport?: string;
  home: string;
  away: string;
  commenceTime?: string;
  market: string;
  outcomes: IngestOutcome[];
}

export interface IngestPayload {
  book: IngestBook;
  /** How long these lines stay usable. Defaults to 120s; prices go stale fast. */
  ttlSeconds?: number;
  /** Replace this book's previous lines rather than merging. Defaults to true. */
  replace?: boolean;
  /**
   * Keep lines for games the main feed does not carry, as events of their own.
   * Defaults to false: when matching fails because of a name variant, this
   * would otherwise show the same game twice.
   */
  createMissingEvents?: boolean;
  lines: IngestLine[];
}

/** Market aliases a scraper is likely to emit, mapped to our internal keys. */
const MARKET_ALIASES: Record<string, string> = {
  moneyline: "h2h",
  ml: "h2h",
  "1x2": "h2h",
  matchodds: "h2h",
  h2h: "h2h",
  spread: "spreads",
  spreads: "spreads",
  handicap: "spreads",
  line: "spreads",
  puckline: "spreads",
  runline: "spreads",
  total: "totals",
  totals: "totals",
  overunder: "totals",
  ou: "totals",
};

export function normalizeMarketKey(market: string): string {
  const cleaned = market.toLowerCase().replace(/[^a-z0-9]/g, "");
  return MARKET_ALIASES[cleaned] ?? market.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

export interface NormalizedOutcome {
  name: string;
  decimal: number;
  point?: number;
  description?: string;
}

export interface NormalizedLine {
  sportKey?: string;
  home: string;
  away: string;
  commenceTime?: string;
  marketKey: string;
  outcomes: NormalizedOutcome[];
}

export interface ValidationResult {
  book: Required<Omit<IngestBook, "title">> & { title: string };
  ttlSeconds: number;
  replace: boolean;
  createMissingEvents: boolean;
  lines: NormalizedLine[];
  /** Human-readable reasons individual lines were dropped. */
  errors: string[];
}

function priceToDecimal(outcome: IngestOutcome): number | null {
  if (outcome.decimal !== undefined) {
    return Number.isFinite(outcome.decimal) && outcome.decimal > 1 ? outcome.decimal : null;
  }
  if (outcome.american !== undefined) {
    if (!Number.isFinite(outcome.american) || outcome.american === 0) return null;
    // American odds between -100 and 100 are not a real quote; a scraper
    // emitting them has almost certainly mislabelled a decimal price.
    if (Math.abs(outcome.american) < 100) return null;
    const decimal = americanToDecimal(outcome.american);
    return Number.isFinite(decimal) && decimal > 1 ? decimal : null;
  }
  return null;
}

export class IngestError extends Error {}

/**
 * Validate and normalize a posted payload.
 *
 * Throws only when the payload as a whole is unusable. Individual bad lines are
 * dropped and reported in `errors`, so one malformed game does not discard a
 * scrape of two hundred good ones.
 */
export function validatePayload(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null) {
    throw new IngestError("Body must be a JSON object.");
  }
  const payload = input as Partial<IngestPayload>;

  const book = payload.book;
  if (!book || typeof book.key !== "string" || !/^[a-z0-9][a-z0-9_-]{1,40}$/i.test(book.key)) {
    throw new IngestError(
      "book.key is required and must be a slug of 2-41 characters (letters, digits, _ or -).",
    );
  }
  if (!Array.isArray(payload.lines)) {
    throw new IngestError("lines must be an array.");
  }
  if (payload.lines.length > 5000) {
    throw new IngestError("Too many lines in one request; post at most 5000.");
  }

  const errors: string[] = [];
  const lines: NormalizedLine[] = [];

  payload.lines.forEach((line, index) => {
    const label = `line ${index}`;

    if (!line || typeof line !== "object") {
      errors.push(`${label}: not an object`);
      return;
    }
    if (typeof line.home !== "string" || typeof line.away !== "string" || !line.home || !line.away) {
      errors.push(`${label}: needs both 'home' and 'away' team names`);
      return;
    }
    if (typeof line.market !== "string" || !line.market) {
      errors.push(`${label}: needs a 'market'`);
      return;
    }
    if (!Array.isArray(line.outcomes) || line.outcomes.length < 2) {
      // A one-sided market cannot be de-vigged and cannot be arbitraged, so it
      // is of no use to any screen in the app.
      errors.push(`${label}: needs at least 2 outcomes (got ${line.outcomes?.length ?? 0})`);
      return;
    }

    let commenceTime: string | undefined;
    if (line.commenceTime !== undefined) {
      const parsed = Date.parse(String(line.commenceTime));
      if (!Number.isFinite(parsed)) {
        errors.push(`${label}: commenceTime '${line.commenceTime}' is not a valid date`);
        return;
      }
      commenceTime = new Date(parsed).toISOString();
    }

    const outcomes: NormalizedOutcome[] = [];
    let failed = false;

    for (const outcome of line.outcomes) {
      if (!outcome || typeof outcome.name !== "string" || !outcome.name) {
        errors.push(`${label}: an outcome is missing 'name'`);
        failed = true;
        break;
      }
      const decimal = priceToDecimal(outcome);
      if (decimal === null) {
        errors.push(
          `${label}: outcome '${outcome.name}' has no usable price ` +
            `(give 'american' of magnitude >= 100, or 'decimal' > 1)`,
        );
        failed = true;
        break;
      }
      if (outcome.point !== undefined && !Number.isFinite(outcome.point)) {
        errors.push(`${label}: outcome '${outcome.name}' has a non-numeric 'point'`);
        failed = true;
        break;
      }
      outcomes.push({
        name: outcome.name,
        decimal,
        point: outcome.point,
        description: outcome.description,
      });
    }

    if (failed) return;

    lines.push({
      sportKey: typeof line.sport === "string" && line.sport ? line.sport : undefined,
      home: line.home,
      away: line.away,
      commenceTime,
      marketKey: normalizeMarketKey(line.market),
      outcomes,
    });
  });

  const sharp = book.sharp === true;
  return {
    book: {
      key: book.key.toLowerCase(),
      title: book.title || book.key,
      sharp,
      // A sharp book with no weight would silently contribute nothing to the
      // consensus, which looks identical to it being ignored.
      sharpWeight: sharp ? clampWeight(book.sharpWeight ?? 0.5) : 0,
    },
    ttlSeconds: clampTtl(payload.ttlSeconds ?? 120),
    replace: payload.replace !== false,
    createMissingEvents: payload.createMissingEvents === true,
    lines,
    errors,
  };
}

function clampWeight(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0.5;
  return Math.min(1, value);
}

function clampTtl(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 120;
  return Math.min(3600, Math.max(5, Math.round(value)));
}
