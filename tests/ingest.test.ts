import { beforeEach, describe, expect, it } from "vitest";
import { IngestError, normalizeMarketKey, validatePayload } from "../src/lib/ingest/types";
import { activeSources, clearSources, putSource } from "../src/lib/ingest/store";
import { attachCustomLines } from "../src/lib/ingest/merge";
import { applyMapping, readPath } from "../src/lib/ingest/pull";
import { scanForEv } from "../src/lib/ev/scanner";
import { bookProfile } from "../src/lib/odds/books";
import { americanToDecimal } from "../src/lib/odds/american";
import type { GameEvent } from "../src/lib/odds/types";

const HOUR = 3_600_000;

function board(): GameEvent[] {
  return [
    {
      id: "g1",
      sportKey: "basketball_nba",
      sportTitle: "NBA",
      commenceTime: new Date(Date.now() + 6 * HOUR).toISOString(),
      homeTeam: "Boston Celtics",
      awayTeam: "Los Angeles Lakers",
      markets: [],
    },
  ];
}

function payload(over: Record<string, unknown> = {}) {
  return {
    book: { key: "mybookie", title: "My Bookie" },
    lines: [
      {
        sport: "basketball_nba",
        home: "Celtics",
        away: "LA Lakers",
        market: "moneyline",
        outcomes: [
          { name: "LA Lakers", american: 120 },
          { name: "Celtics", american: -140 },
        ],
      },
    ],
    ...over,
  };
}

beforeEach(() => clearSources());

describe("payload validation", () => {
  it("accepts american and decimal prices interchangeably", () => {
    const result = validatePayload(
      payload({
        lines: [
          {
            home: "Celtics",
            away: "Lakers",
            market: "h2h",
            outcomes: [
              { name: "Lakers", american: 120 },
              { name: "Celtics", decimal: 1.71 },
            ],
          },
        ],
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.lines[0].outcomes[0].decimal).toBeCloseTo(americanToDecimal(120), 9);
    expect(result.lines[0].outcomes[1].decimal).toBe(1.71);
  });

  it("maps the market names a scraper actually emits", () => {
    expect(normalizeMarketKey("Moneyline")).toBe("h2h");
    expect(normalizeMarketKey("ML")).toBe("h2h");
    expect(normalizeMarketKey("Over/Under")).toBe("totals");
    expect(normalizeMarketKey("Run Line")).toBe("spreads");
    expect(normalizeMarketKey("player_points")).toBe("player_points");
  });

  it("rejects a payload with no usable book key", () => {
    expect(() => validatePayload({ lines: [] })).toThrow(IngestError);
    expect(() => validatePayload({ book: { key: "!!" }, lines: [] })).toThrow(IngestError);
    expect(() => validatePayload({ book: { key: "ok" } })).toThrow(IngestError);
  });

  it("drops bad lines individually and says why", () => {
    const result = validatePayload(
      payload({
        lines: [
          // Good.
          {
            home: "Celtics",
            away: "Lakers",
            market: "h2h",
            outcomes: [
              { name: "Lakers", american: 120 },
              { name: "Celtics", american: -140 },
            ],
          },
          // One-sided: cannot be de-vigged or arbitraged.
          { home: "A", away: "B", market: "h2h", outcomes: [{ name: "A", american: 100 }] },
          // A price of 0 is not a price.
          {
            home: "A",
            away: "B",
            market: "h2h",
            outcomes: [
              { name: "A", american: 0 },
              { name: "B", american: 100 },
            ],
          },
          // -50 is almost certainly a mislabelled decimal, not American odds.
          {
            home: "A",
            away: "B",
            market: "h2h",
            outcomes: [
              { name: "A", american: -50 },
              { name: "B", american: 100 },
            ],
          },
          { home: "A", market: "h2h", outcomes: [] },
        ],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.errors).toHaveLength(4);
    expect(result.errors.join(" ")).toContain("at least 2 outcomes");
    expect(result.errors.join(" ")).toContain("no usable price");
  });

  it("refuses to let a custom source impersonate a built-in book", () => {
    const result = validatePayload(payload({ book: { key: "pinnacle", sharp: true } }));
    putSource(result);
    // The built-in profile must win, so a scraper cannot promote itself into
    // the fair line by claiming a trusted key.
    expect(bookProfile("pinnacle").title).toBe("Pinnacle");
    expect(bookProfile("pinnacle").sharpWeight).toBe(1);
  });

  it("defaults a new source to soft, and weights it only when asked", () => {
    expect(validatePayload(payload()).book.sharp).toBe(false);
    expect(validatePayload(payload()).book.sharpWeight).toBe(0);

    const sharp = validatePayload(payload({ book: { key: "sharpie", sharp: true } }));
    expect(sharp.book.sharpWeight).toBe(0.5);
    expect(
      validatePayload(payload({ book: { key: "s2", sharp: true, sharpWeight: 0.9 } })).book
        .sharpWeight,
    ).toBe(0.9);
  });

  it("clamps the time-to-live into a sane band", () => {
    expect(validatePayload(payload({ ttlSeconds: 0 })).ttlSeconds).toBe(120);
    expect(validatePayload(payload({ ttlSeconds: 999999 })).ttlSeconds).toBe(3600);
    expect(validatePayload(payload({ ttlSeconds: 45 })).ttlSeconds).toBe(45);
  });
});

describe("merging custom lines onto the board", () => {
  it("attaches a scraped line to the right game and canonicalizes the names", () => {
    putSource(validatePayload(payload()));
    const events = board();
    const { events: merged, stats } = attachCustomLines(events, activeSources());

    expect(stats[0]).toMatchObject({ book: "mybookie", matched: 1, unmatched: 0 });

    const market = merged[0].markets.find((m) => m.bookmaker === "mybookie")!;
    expect(market.marketKey).toBe("h2h");
    // "LA Lakers" must become the feed's spelling or it groups with nothing.
    expect(market.outcomes.map((o) => o.name).sort()).toEqual([
      "Boston Celtics",
      "Los Angeles Lakers",
    ]);
  });

  it("does not mutate the cached board it was given", () => {
    putSource(validatePayload(payload()));
    const events = board();
    attachCustomLines(events, activeSources());
    attachCustomLines(events, activeSources());
    // Mutating in place would append the same market on every request until
    // the odds cache expired.
    expect(events[0].markets).toHaveLength(0);
  });

  it("counts lines it could not place instead of attaching them anywhere", () => {
    putSource(
      validatePayload(
        payload({
          lines: [
            {
              home: "Miami Heat",
              away: "Chicago Bulls",
              market: "h2h",
              outcomes: [
                { name: "Chicago Bulls", american: 120 },
                { name: "Miami Heat", american: -140 },
              ],
            },
          ],
        }),
      ),
    );
    const { events, stats } = attachCustomLines(board(), activeSources());
    expect(stats[0]).toMatchObject({ matched: 0, unmatched: 1, created: 0 });
    expect(events[0].markets).toHaveLength(0);
  });

  it("keeps unmatched games as their own events when asked to", () => {
    putSource(
      validatePayload(
        payload({
          createMissingEvents: true,
          lines: [
            {
              home: "Miami Heat",
              away: "Chicago Bulls",
              sport: "basketball_nba",
              commenceTime: new Date(Date.now() + 5 * HOUR).toISOString(),
              market: "h2h",
              outcomes: [
                { name: "Chicago Bulls", american: 120 },
                { name: "Miami Heat", american: -140 },
              ],
            },
          ],
        }),
      ),
    );
    const { events, stats } = attachCustomLines(board(), activeSources());
    expect(stats[0].created).toBe(1);
    expect(events).toHaveLength(2);
    expect(events[1].homeTeam).toBe("Miami Heat");
  });

  it("lets a trusted private source define the fair line end to end", () => {
    // A sharp private book at -110/-110 makes the market 50/50; the soft book's
    // +120 on the same side is then a real, computable edge.
    putSource(
      validatePayload({
        book: { key: "sharpfeed", title: "Sharp Feed", sharp: true, sharpWeight: 1 },
        lines: [
          {
            sport: "basketball_nba",
            home: "Celtics",
            away: "LA Lakers",
            market: "h2h",
            outcomes: [
              { name: "LA Lakers", american: -110 },
              { name: "Celtics", american: -110 },
            ],
          },
        ],
      }),
    );
    putSource(
      validatePayload({
        book: { key: "softbook", title: "Soft Book" },
        lines: [
          {
            sport: "basketball_nba",
            home: "Celtics",
            away: "LA Lakers",
            market: "h2h",
            outcomes: [
              { name: "LA Lakers", american: 120 },
              { name: "Celtics", american: -140 },
            ],
          },
        ],
      }),
    );

    const { events } = attachCustomLines(board(), activeSources());
    const found = scanForEv(events, { sharpBooks: ["sharpfeed"], minEvPercent: 1 });

    expect(found).toHaveLength(1);
    expect(found[0].book).toBe("softbook");
    expect(found[0].selection).toBe("Los Angeles Lakers");
    // Fair 50%, offered +120 => 0.5 * 2.2 - 1 = +10%.
    expect(found[0].evPercent).toBeCloseTo(10, 6);
  });
});

describe("private API field mapping", () => {
  const body = {
    data: {
      events: [
        {
          fixture: { home: "Celtics", away: "LA Lakers", starts: "2030-01-01T00:00:00Z" },
          type: "Moneyline",
          selections: [
            { label: "LA Lakers", price_us: "+120" },
            { label: "Celtics", price_us: "-140" },
          ],
        },
      ],
    },
  };

  const config = {
    key: "private",
    url: "https://example.invalid/odds",
    mapping: {
      lines: "data.events",
      home: "fixture.home",
      away: "fixture.away",
      commenceTime: "fixture.starts",
      market: "type",
      outcomes: "selections",
      outcomeName: "label",
      american: "price_us",
    },
  };

  it("reads nested paths and tolerates missing ones", () => {
    expect(readPath(body, "data.events.0.type")).toBe("Moneyline");
    expect(readPath(body, "data.missing.deeper")).toBeUndefined();
    expect(readPath(body, undefined)).toBeUndefined();
  });

  it("translates a private response into a valid payload", () => {
    const result = validatePayload(applyMapping(body, config));
    expect(result.errors).toEqual([]);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].marketKey).toBe("h2h");
    // Odds arrive as strings with a leading "+" more often than not.
    expect(result.lines[0].outcomes[0].decimal).toBeCloseTo(2.2, 9);
  });

  it("produces an empty payload rather than throwing on an unexpected shape", () => {
    const mapped = applyMapping({ nope: true }, config);
    expect(mapped.lines).toEqual([]);
  });
});
