import { describe, expect, it } from "vitest";
import { analyzeHar, inferMapping, toSourceConfig } from "../src/lib/ingest/discover";
import { applyMapping } from "../src/lib/ingest/pull";
import { validatePayload } from "../src/lib/ingest/types";

/** A shape where each game nests markets, each with its own outcomes. */
const NESTED_MARKETS = {
  events: [
    {
      id: 991,
      home_team: "Boston Celtics",
      away_team: "Los Angeles Lakers",
      start_time: "2030-01-01T00:00:00Z",
      markets: [
        {
          market_type: "Moneyline",
          outcomes: [
            { name: "Los Angeles Lakers", price: 120 },
            { name: "Boston Celtics", price: -140 },
          ],
        },
      ],
    },
  ],
};

/** A flatter shape: one market per game, decimal prices as strings. */
const FLAT_DECIMAL = {
  data: {
    fixtures: [
      {
        homeName: "Arsenal",
        awayName: "Chelsea",
        kickoff: "2030-02-02T15:00:00Z",
        selections: [
          { selection_name: "Arsenal", decimal_odds: "2.10", handicap: 0 },
          { selection_name: "Draw", decimal_odds: "3.40", handicap: 0 },
          { selection_name: "Chelsea", decimal_odds: "3.75", handicap: 0 },
        ],
      },
    ],
  },
};

describe("inferring a mapping from a response", () => {
  it("finds games nested under a markets array", () => {
    const result = inferMapping(NESTED_MARKETS)!;
    expect(result).not.toBeNull();
    expect(result.mapping.lines).toBe("events");
    expect(result.mapping.home).toBe("home_team");
    expect(result.mapping.away).toBe("away_team");
    expect(result.mapping.commenceTime).toBe("start_time");
    // Recognised as an array of markets to iterate, not "the first market".
    expect(result.mapping.markets).toBe("markets");
    expect(result.mapping.outcomes).toBe("outcomes");
    expect(result.mapping.market).toBe("market_type");
    expect(result.mapping.outcomeName).toBe("name");
    // ±120 is American, not decimal.
    expect(result.mapping.american).toBe("price");
    expect(result.mapping.decimal).toBeUndefined();
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it("recognises decimal prices given as strings", () => {
    const result = inferMapping(FLAT_DECIMAL)!;
    expect(result.mapping.lines).toBe("data.fixtures");
    expect(result.mapping.outcomes).toBe("selections");
    expect(result.mapping.decimal).toBe("decimal_odds");
    expect(result.mapping.american).toBeUndefined();
    expect(result.mapping.point).toBe("handicap");
  });

  it("produces a mapping that actually parses the response it came from", () => {
    // The real test of an inferred mapping: feed it back through the same
    // pull + validation path the server uses.
    for (const body of [NESTED_MARKETS, FLAT_DECIMAL]) {
      const inferred = inferMapping(body)!;
      const config = {
        key: "mybookie",
        url: "https://example.invalid",
        mapping: inferred.mapping,
      };
      const result = validatePayload(applyMapping(body, config));
      expect(result.errors).toEqual([]);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].outcomes.length).toBeGreaterThanOrEqual(2);
      for (const outcome of result.lines[0].outcomes) {
        expect(outcome.decimal).toBeGreaterThan(1);
      }
    }
  });

  it("reads every market on a game, not just the first", () => {
    // The shape most books use. Reading only markets[0] would silently drop
    // the spread and the total from every game on the board.
    const body = {
      events: [
        {
          home_team: "Boston Celtics",
          away_team: "Los Angeles Lakers",
          start_time: "2030-01-01T00:00:00Z",
          markets: [
            {
              market_type: "Moneyline",
              outcomes: [
                { name: "Los Angeles Lakers", price: 120 },
                { name: "Boston Celtics", price: -140 },
              ],
            },
            {
              market_type: "Total",
              outcomes: [
                { name: "Over", price: -110, line: 224.5 },
                { name: "Under", price: -110, line: 224.5 },
              ],
            },
          ],
        },
      ],
    };

    const inferred = inferMapping(body)!;
    const result = validatePayload(
      applyMapping(body, { key: "mybookie", url: "https://x.invalid", mapping: inferred.mapping }),
    );

    expect(result.errors).toEqual([]);
    expect(result.lines).toHaveLength(2);
    expect(result.lines.map((l) => l.marketKey).sort()).toEqual(["h2h", "totals"]);
    const total = result.lines.find((l) => l.marketKey === "totals")!;
    expect(total.outcomes.every((o) => o.point === 224.5)).toBe(true);
  });

  it("handles a bare top-level array", () => {
    const result = inferMapping([
      {
        home: "A Team",
        away: "B Team",
        odds: [
          { label: "A Team", american: -110 },
          { label: "B Team", american: -110 },
        ],
      },
    ])!;
    expect(result.mapping.lines).toBeUndefined();
    expect(result.mapping.outcomes).toBe("odds");
  });

  it("ignores JSON that is not an odds feed", () => {
    expect(inferMapping({ user: { id: 1, name: "x" } })).toBeNull();
    expect(inferMapping({ items: [{ sku: "a", qty: 2 }] })).toBeNull();
    // Analytics payloads have names and numbers but no prices on outcomes.
    expect(inferMapping({ events: [{ name: "page_view", count: 3 }] })).toBeNull();
  });

  it("flags what it could not work out instead of inventing it", () => {
    const result = inferMapping({
      games: [
        {
          competitors: ["A", "B"],
          lines: [
            { label: "A", price: -110 },
            { label: "B", price: -110 },
          ],
        },
      ],
    })!;
    expect(result.notes.join(" ")).toContain("home/away");
    expect(result.confidence).toBeLessThan(0.7);
  });
});

describe("analyzing a HAR capture", () => {
  const har = {
    log: {
      entries: [
        {
          request: { url: "https://cdn.book.example/app.js", method: "GET", headers: [] },
          response: { status: 200, content: { mimeType: "application/javascript", text: "var a=1;" } },
        },
        {
          request: {
            url: "https://api.book.example/v2/sports/basketball/events?live=false",
            method: "GET",
            headers: [
              { name: "Authorization", value: "Bearer SECRET-DO-NOT-LEAK" },
              { name: "X-Device-Id", value: "abc123" },
              { name: "Accept", value: "application/json" },
            ],
          },
          response: {
            status: 200,
            content: { mimeType: "application/json", text: JSON.stringify(NESTED_MARKETS) },
          },
        },
        {
          request: { url: "https://analytics.book.example/t", method: "POST", headers: [] },
          response: {
            status: 200,
            content: { mimeType: "application/json", text: JSON.stringify({ ok: true }) },
          },
        },
      ],
    },
  };

  it("picks the odds endpoint out of the noise", () => {
    const found = analyzeHar(har);
    expect(found).toHaveLength(1);
    expect(found[0].url).toContain("api.book.example");
    expect(found[0].gameCount).toBe(1);
    expect(found[0].mapping.markets).toBe("markets");
    expect(found[0].mapping.outcomes).toBe("outcomes");
  });

  it("reports which headers are needed without echoing their values", () => {
    const [found] = analyzeHar(har);
    expect(found.authHeaders).toContain("Authorization");
    expect(found.authHeaders).toContain("X-Device-Id");
    expect(found.authHeaders).not.toContain("Accept");

    // A HAR holds live session tokens; the value must never be carried over.
    const serialized = JSON.stringify(toSourceConfig(found, "mybookie"));
    expect(serialized).not.toContain("SECRET-DO-NOT-LEAK");
    expect(serialized).not.toContain("abc123");
    expect(serialized).toContain("REPLACE_WITH_YOUR_AUTHORIZATION");
  });

  it("emits a config that drops straight into CUSTOM_SOURCES", () => {
    const config = toSourceConfig(analyzeHar(har)[0], "mybookie");
    expect(config.key).toBe("mybookie");
    expect(config.sharp).toBe(false);
    const result = validatePayload(applyMapping(NESTED_MARKETS, config));
    expect(result.lines).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it("survives a capture with junk in it", () => {
    expect(analyzeHar({})).toEqual([]);
    expect(analyzeHar({ log: { entries: [{ response: { content: { text: "not json" } } }] } })).toEqual([]);
  });
});
