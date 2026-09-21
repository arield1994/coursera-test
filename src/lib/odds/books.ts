/**
 * Bookmaker registry.
 *
 * The scanner's whole premise is that *some* books price more accurately than
 * others. A sharp book takes large bets from winning players and moves its line
 * in response, so its devigged price is a usable probability estimate. A soft
 * book caps winners and leaves stale prices up — which is where the edge is.
 *
 * `sharpWeight` drives the consensus fair line: it is how much a book's opinion
 * counts, not how good its prices are for *you*.
 */

export interface BookProfile {
  key: string;
  title: string;
  /** Sharp books form the fair line. Soft books are where bets get placed. */
  sharp: boolean;
  sharpWeight: number;
  region: "us" | "eu" | "uk" | "au" | "exchange";
}

export const BOOKS: BookProfile[] = [
  // Reference / sharp markets.
  { key: "pinnacle", title: "Pinnacle", sharp: true, sharpWeight: 1.0, region: "eu" },
  { key: "circasports", title: "Circa Sports", sharp: true, sharpWeight: 0.9, region: "us" },
  { key: "betfair_ex_eu", title: "Betfair Exchange", sharp: true, sharpWeight: 0.85, region: "exchange" },
  { key: "novig", title: "Novig", sharp: true, sharpWeight: 0.6, region: "exchange" },
  { key: "prophetx", title: "ProphetX", sharp: true, sharpWeight: 0.6, region: "exchange" },
  { key: "betonlineag", title: "BetOnline", sharp: true, sharpWeight: 0.55, region: "us" },

  // Soft / retail books — the targets.
  { key: "draftkings", title: "DraftKings", sharp: false, sharpWeight: 0, region: "us" },
  { key: "fanduel", title: "FanDuel", sharp: false, sharpWeight: 0, region: "us" },
  { key: "betmgm", title: "BetMGM", sharp: false, sharpWeight: 0, region: "us" },
  { key: "caesars", title: "Caesars", sharp: false, sharpWeight: 0, region: "us" },
  { key: "espnbet", title: "ESPN BET", sharp: false, sharpWeight: 0, region: "us" },
  { key: "betrivers", title: "BetRivers", sharp: false, sharpWeight: 0, region: "us" },
  { key: "hardrockbet", title: "Hard Rock Bet", sharp: false, sharpWeight: 0, region: "us" },
  { key: "fanatics", title: "Fanatics", sharp: false, sharpWeight: 0, region: "us" },
  { key: "bet365", title: "bet365", sharp: false, sharpWeight: 0, region: "uk" },
  { key: "williamhill_us", title: "Caesars (WH)", sharp: false, sharpWeight: 0, region: "us" },
  { key: "ballybet", title: "Bally Bet", sharp: false, sharpWeight: 0, region: "us" },
  { key: "windcreek", title: "Wind Creek", sharp: false, sharpWeight: 0, region: "us" },
];

const BY_KEY = new Map(BOOKS.map((b) => [b.key, b]));

/**
 * Books added at runtime: private bookie APIs and scrapers registered through
 * /api/ingest or a configured pull source.
 *
 * Kept separate from BOOKS so the built-in registry stays a constant, and so
 * a custom source can never silently redefine what "pinnacle" means.
 */
const CUSTOM_BY_KEY = new Map<string, BookProfile>();

export function registerBook(profile: BookProfile): BookProfile {
  if (BY_KEY.has(profile.key)) {
    // Built-ins win. Otherwise a scraper claiming key "pinnacle" could promote
    // itself into the fair line.
    return BY_KEY.get(profile.key)!;
  }
  CUSTOM_BY_KEY.set(profile.key, profile);
  return profile;
}

export function unregisterBook(key: string): void {
  CUSTOM_BY_KEY.delete(key);
}

export function customBooks(): BookProfile[] {
  return [...CUSTOM_BY_KEY.values()];
}

export function isCustomBook(key: string): boolean {
  return CUSTOM_BY_KEY.has(key);
}

export function bookProfile(key: string): BookProfile {
  return (
    BY_KEY.get(key) ??
    CUSTOM_BY_KEY.get(key) ?? {
      key,
      title: key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      // Unknown books are assumed soft: treating an unknown book as sharp would
      // let it define the fair line, which is how scanners invent fake edges.
      sharp: false,
      sharpWeight: 0,
      region: "us",
    }
  );
}

export function bookTitle(key: string): string {
  return bookProfile(key).title;
}

export const DEFAULT_SHARP_BOOKS = ["pinnacle", "circasports", "betfair_ex_eu"];

export const SHARP_BOOKS = BOOKS.filter((b) => b.sharp);
export const SOFT_BOOKS = BOOKS.filter((b) => !b.sharp);

/** Built-ins plus anything registered at runtime, for pickers and filters. */
export function allBooks(): BookProfile[] {
  return [...BOOKS, ...CUSTOM_BY_KEY.values()];
}
