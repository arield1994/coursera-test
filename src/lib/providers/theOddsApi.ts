/**
 * Adapter for The Odds API (v4).
 *
 * Prices are requested in decimal format so no conversion happens here beyond
 * reshaping — the less arithmetic at the provider boundary, the fewer places a
 * rounding error can enter the EV calculation.
 *
 * Quota matters: every sport in a request costs credits, and player-prop
 * markets are per-event endpoints. The caller is expected to cache (see
 * `lib/cache.ts`) rather than poll this directly.
 */

import type { GameEvent, Sport, BookMarket, Outcome } from "../odds/types";
import { bookTitle } from "../odds/books";
import { ProviderError, type OddsProvider } from "./types";

const BASE_URL = "https://api.the-odds-api.com/v4";

interface RawOutcome {
  name: string;
  price: number;
  point?: number;
  description?: string;
}

interface RawMarket {
  key: string;
  last_update?: string;
  outcomes: RawOutcome[];
}

interface RawBookmaker {
  key: string;
  title: string;
  last_update?: string;
  markets: RawMarket[];
}

interface RawEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: RawBookmaker[];
}

function normalizeEvent(raw: RawEvent): GameEvent {
  const markets: BookMarket[] = [];

  for (const bookmaker of raw.bookmakers ?? []) {
    for (const market of bookmaker.markets ?? []) {
      const outcomes: Outcome[] = (market.outcomes ?? [])
        .filter((o) => Number.isFinite(o.price) && o.price > 1)
        .map((o) => ({
          name: o.name,
          price: o.price,
          point: o.point,
          description: o.description,
        }));
      if (outcomes.length === 0) continue;

      markets.push({
        bookmaker: bookmaker.key,
        bookmakerTitle: bookmaker.title || bookTitle(bookmaker.key),
        marketKey: market.key,
        lastUpdate: market.last_update ?? bookmaker.last_update ?? new Date().toISOString(),
        outcomes,
      });
    }
  }

  return {
    id: raw.id,
    sportKey: raw.sport_key,
    sportTitle: raw.sport_title,
    commenceTime: raw.commence_time,
    homeTeam: raw.home_team,
    awayTeam: raw.away_team,
    markets,
  };
}

export class TheOddsApiProvider implements OddsProvider {
  readonly name = "the-odds-api";
  readonly isDemo = false;

  constructor(private readonly apiKey: string) {}

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set("apiKey", this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }

    let response: Response;
    try {
      response = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (cause) {
      throw new ProviderError(
        `Could not reach The Odds API: ${(cause as Error).message}`,
        undefined,
        "Check outbound network access from the server.",
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const hint =
        response.status === 401
          ? "ODDS_API_KEY is missing or invalid."
          : response.status === 429
            ? "Monthly request quota exhausted — raise the cache TTL or narrow the sports list."
            : undefined;
      throw new ProviderError(
        `The Odds API returned ${response.status}: ${body.slice(0, 200)}`,
        response.status,
        hint,
      );
    }

    return (await response.json()) as T;
  }

  async listSports(): Promise<Sport[]> {
    const raw = await this.request<
      { key: string; group: string; title: string; active: boolean }[]
    >("/sports", {});
    return raw.map((s) => ({
      key: s.key,
      group: s.group,
      title: s.title,
      active: s.active,
    }));
  }

  async fetchOdds({
    sportKeys,
    marketKeys,
    regions = ["us", "eu"],
  }: {
    sportKeys: string[];
    marketKeys: string[];
    regions?: string[];
  }): Promise<GameEvent[]> {
    // Each sport is a separate endpoint and therefore a separate credit spend;
    // they're fetched together so one slow sport doesn't serialise the rest.
    const batches = await Promise.all(
      sportKeys.map(async (sportKey) => {
        try {
          const raw = await this.request<RawEvent[]>(`/sports/${sportKey}/odds`, {
            regions: regions.join(","),
            markets: marketKeys.join(","),
            oddsFormat: "decimal",
            dateFormat: "iso",
          });
          return raw.map(normalizeEvent);
        } catch (error) {
          // One unsupported or out-of-season sport shouldn't blank the board.
          if (error instanceof ProviderError && error.status === 422) return [];
          throw error;
        }
      }),
    );

    return batches.flat();
  }
}
