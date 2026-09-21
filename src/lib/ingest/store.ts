/**
 * Live store of lines pushed in from outside the main odds feed.
 *
 * Process-local and intentionally so: these are prices with a shelf life of
 * seconds to minutes, not records. If the server restarts, the right answer is
 * for the scraper to post again on its next cycle, not for us to serve prices
 * from before the restart. Anything needing durability belongs in a database
 * the scraper owns, not here.
 */

import { registerBook, unregisterBook, type BookProfile } from "../odds/books";
import type { NormalizedLine, ValidationResult } from "./types";

export interface StoredSource {
  book: BookProfile;
  lines: NormalizedLine[];
  receivedAt: number;
  expiresAt: number;
  ttlSeconds: number;
  /** Keep lines whose game is absent from the main feed as standalone events. */
  createMissingEvents: boolean;
  /** Set by the merge step so the UI can show whether matching is working. */
  lastMatched?: number;
  lastUnmatched?: number;
}

const sources = new Map<string, StoredSource>();

export function putSource(result: ValidationResult): StoredSource {
  const now = Date.now();
  const existing = sources.get(result.book.key);

  const profile: BookProfile = registerBook({
    key: result.book.key,
    title: result.book.title,
    sharp: result.book.sharp,
    sharpWeight: result.book.sharpWeight,
    region: "us",
  });

  const lines =
    result.replace || !existing
      ? result.lines
      : mergeLines(existing.lines, result.lines);

  const stored: StoredSource = {
    book: profile,
    lines,
    receivedAt: now,
    expiresAt: now + result.ttlSeconds * 1000,
    ttlSeconds: result.ttlSeconds,
    createMissingEvents: result.createMissingEvents,
  };
  sources.set(profile.key, stored);
  return stored;
}

/**
 * Replace same-market lines and keep the rest.
 *
 * A scraper posting incrementally (one sport per request) must not wipe the
 * sports it did not mention, but re-posting the same game must overwrite rather
 * than accumulate two prices for one market.
 */
function mergeLines(existing: NormalizedLine[], incoming: NormalizedLine[]): NormalizedLine[] {
  const key = (line: NormalizedLine) =>
    [line.sportKey ?? "", line.home, line.away, line.marketKey]
      .join("|")
      .toLowerCase();

  const merged = new Map(existing.map((line) => [key(line), line]));
  for (const line of incoming) merged.set(key(line), line);
  return [...merged.values()];
}

/** Active sources, dropping any whose lines have gone stale. */
export function activeSources(): StoredSource[] {
  const now = Date.now();
  for (const [key, source] of sources) {
    if (source.expiresAt <= now) {
      sources.delete(key);
      unregisterBook(key);
    }
  }
  return [...sources.values()];
}

export function removeSource(key: string): boolean {
  unregisterBook(key);
  return sources.delete(key);
}

export function clearSources(): void {
  for (const key of sources.keys()) unregisterBook(key);
  sources.clear();
}

export function recordMatchStats(key: string, matched: number, unmatched: number): void {
  const source = sources.get(key);
  if (!source) return;
  source.lastMatched = matched;
  source.lastUnmatched = unmatched;
}
