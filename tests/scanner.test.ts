import { describe, expect, it } from "vitest";
import { scanForEv, groupMarkets, fairLines } from "../src/lib/ev/scanner";
import { marketGroupKey, outcomeKey } from "../src/lib/odds/types";
import { generateMockEvents } from "../src/lib/providers/mock";
import { balancedPinnacleMoneyline, event, market, HOUR } from "./fixtures";

const OPTS = {
  sharpBooks: ["pinnacle"],
  minEvPercent: 0.5,
  stake: { bankroll: 1000, kellyMultiplier: 0.25, maxStakeFraction: 1 },
};

describe("scanner", () => {
  it("finds the soft book's overpriced side and ignores the other one", () => {
    const events = [
      event([
        balancedPinnacleMoneyline(),
        market("draftkings", "h2h", [
          { name: "Chiefs", price: 0, american: 105 },
          { name: "Bills", price: 0, american: -125 },
        ]),
      ]),
    ];

    const found = scanForEv(events, OPTS);
    expect(found).toHaveLength(1);
    const [bet] = found;
    expect(bet.book).toBe("draftkings");
    expect(bet.selection).toBe("Chiefs");
    // Fair 50%, offered +105 => 2.5% edge.
    expect(bet.evPercent).toBeCloseTo(2.5, 6);
    expect(bet.fairProbability).toBeCloseTo(0.5, 9);
    expect(bet.american).toBeCloseTo(105, 6);
    expect(bet.stake).toBeCloseTo(5.95, 2);
    expect(bet.sharpBooksUsed).toEqual(["pinnacle"]);
  });

  it("never reports the sharp book itself as a bet", () => {
    const events = [
      event([
        balancedPinnacleMoneyline(),
        market("draftkings", "h2h", [
          { name: "Chiefs", price: 0, american: 105 },
          { name: "Bills", price: 0, american: -125 },
        ]),
      ]),
    ];
    expect(scanForEv(events, OPTS).every((o) => o.book !== "pinnacle")).toBe(true);
  });

  it("refuses to compare different lines", () => {
    // Pinnacle prices the 46.5; DraftKings hung the 45.5. These are different
    // bets, and pricing one against the other is the classic fake edge.
    const events = [
      event([
        market("pinnacle", "totals", [
          { name: "Over", price: 0, american: -110, point: 46.5 },
          { name: "Under", price: 0, american: -110, point: 46.5 },
        ]),
        market("draftkings", "totals", [
          { name: "Over", price: 0, american: 120, point: 45.5 },
          { name: "Under", price: 0, american: -140, point: 45.5 },
        ]),
      ]),
    ];
    expect(scanForEv(events, { ...OPTS, minEvPercent: -100 })).toHaveLength(0);
  });

  it("groups the two sides of a spread despite their opposite handicaps", () => {
    const events = [
      event([
        market("pinnacle", "spreads", [
          { name: "Chiefs", price: 0, american: -110, point: -3.5 },
          { name: "Bills", price: 0, american: -110, point: 3.5 },
        ]),
        market("draftkings", "spreads", [
          { name: "Chiefs", price: 0, american: 105, point: -3.5 },
        ]),
      ]),
    ];
    const groups = groupMarkets(events);
    const spreadGroups = groups.filter((g) => g.marketKey === "spreads");
    expect(spreadGroups).toHaveLength(1);

    const found = scanForEv(events, OPTS);
    expect(found).toHaveLength(1);
    expect(found[0].selection).toBe("Chiefs -3.5");
    expect(found[0].point).toBe(-3.5);
    // Matched against Pinnacle's own -3.5, devigged to 50%: +105 is +2.5%.
    expect(found[0].evPercent).toBeCloseTo(2.5, 6);
  });

  it("skips markets with no sharp reference rather than devigging the field", () => {
    const events = [
      event([
        market("draftkings", "h2h", [
          { name: "Chiefs", price: 0, american: 105 },
          { name: "Bills", price: 0, american: -125 },
        ]),
        market("fanduel", "h2h", [
          { name: "Chiefs", price: 0, american: -130 },
          { name: "Bills", price: 0, american: 110 },
        ]),
      ]),
    ];
    expect(scanForEv(events, { ...OPTS, minEvPercent: -100 })).toHaveLength(0);
  });

  it("will not devig a sharp book that only posted half the market", () => {
    const events = [
      event([
        market("pinnacle", "h2h", [{ name: "Chiefs", price: 0, american: -110 }]),
        market("draftkings", "h2h", [
          { name: "Chiefs", price: 0, american: 105 },
          { name: "Bills", price: 0, american: -125 },
        ]),
      ]),
    ];
    expect(scanForEv(events, { ...OPTS, minEvPercent: -100 })).toHaveLength(0);
  });

  it("honours the minimum sharp-book count", () => {
    const events = [
      event([
        balancedPinnacleMoneyline(),
        market("draftkings", "h2h", [
          { name: "Chiefs", price: 0, american: 105 },
          { name: "Bills", price: 0, american: -125 },
        ]),
      ]),
    ];
    expect(scanForEv(events, { ...OPTS, minSharpBooks: 2 })).toHaveLength(0);
    expect(scanForEv(events, { ...OPTS, minSharpBooks: 1 })).toHaveLength(1);
  });

  it("excludes events that have already started", () => {
    const events = [
      event(
        [
          balancedPinnacleMoneyline(),
          market("draftkings", "h2h", [
            { name: "Chiefs", price: 0, american: 105 },
            { name: "Bills", price: 0, american: -125 },
          ]),
        ],
        { commenceTime: new Date(Date.now() - HOUR).toISOString() },
      ),
    ];
    expect(scanForEv(events, OPTS)).toHaveLength(0);
  });

  it("respects the lookahead horizon", () => {
    const events = [
      event(
        [
          balancedPinnacleMoneyline(),
          market("draftkings", "h2h", [
            { name: "Chiefs", price: 0, american: 105 },
            { name: "Bills", price: 0, american: -125 },
          ]),
        ],
        { commenceTime: new Date(Date.now() + 72 * HOUR).toISOString() },
      ),
    ];
    expect(scanForEv(events, { ...OPTS, maxHoursAhead: 24 })).toHaveLength(0);
    expect(scanForEv(events, { ...OPTS, maxHoursAhead: 96 })).toHaveLength(1);
  });

  it("flags an implausible edge instead of hiding it", () => {
    const events = [
      event([
        balancedPinnacleMoneyline(),
        market("draftkings", "h2h", [
          { name: "Chiefs", price: 0, american: 145 },
          { name: "Bills", price: 0, american: -125 },
        ]),
      ]),
    ];
    const [bet] = scanForEv(events, OPTS);
    expect(bet.evPercent).toBeCloseTo(22.5, 6);
    expect(bet.flags).toContain("stale-suspect");
    // Above the hard ceiling it is dropped entirely.
    expect(scanForEv(events, { ...OPTS, maxEvPercent: 20 })).toHaveLength(0);
  });

  it("reports the best price available anywhere for line shopping", () => {
    const events = [
      event([
        balancedPinnacleMoneyline(),
        market("draftkings", "h2h", [
          { name: "Chiefs", price: 0, american: 105 },
          { name: "Bills", price: 0, american: -125 },
        ]),
        market("betmgm", "h2h", [
          { name: "Chiefs", price: 0, american: 115 },
          { name: "Bills", price: 0, american: -135 },
        ]),
      ]),
    ];
    const dk = scanForEv(events, OPTS).find((o) => o.book === "draftkings")!;
    expect(dk.bestAvailableBook).toBe("betmgm");
    expect(dk.bestAvailableDecimal).toBeGreaterThan(dk.decimal);
  });

  it("respects the target-book filter", () => {
    const events = [
      event([
        balancedPinnacleMoneyline(),
        market("draftkings", "h2h", [
          { name: "Chiefs", price: 0, american: 105 },
          { name: "Bills", price: 0, american: -125 },
        ]),
        market("betmgm", "h2h", [
          { name: "Chiefs", price: 0, american: 115 },
          { name: "Bills", price: 0, american: -135 },
        ]),
      ]),
    ];
    const found = scanForEv(events, { ...OPTS, targetBooks: ["betmgm"] });
    expect(found).toHaveLength(1);
    expect(found[0].book).toBe("betmgm");
  });

  it("produces a plausible board from the demo feed", () => {
    const found = scanForEv(generateMockEvents({ seed: 7 }), {
      sharpBooks: ["pinnacle", "circasports", "betfair_ex_eu"],
      minEvPercent: 1,
    });
    expect(found.length).toBeGreaterThan(5);
    // Sorted by edge, all within the configured band, never a sharp book.
    expect(found).toEqual([...found].sort((a, b) => b.evPercent - a.evPercent));
    for (const o of found) {
      expect(o.evPercent).toBeGreaterThanOrEqual(1);
      expect(o.evPercent).toBeLessThanOrEqual(40);
      expect(o.fairProbability).toBeGreaterThan(0);
      expect(o.fairProbability).toBeLessThan(1);
      expect(o.stake).toBeGreaterThanOrEqual(0);
      expect(["pinnacle", "circasports", "betfair_ex_eu"]).not.toContain(o.book);
    }
    // Edges should be mostly modest. A board where the typical play is a 10%
    // edge means the fair line is wrong, not that we found a goldmine -- so
    // the demo feed is held to a distribution a real board could produce.
    const edges = found.map((o) => o.evPercent).sort((a, b) => a - b);
    const median = edges[Math.floor(edges.length / 2)];
    expect(median).toBeLessThan(4);
    expect(edges[Math.floor(edges.length * 0.9)]).toBeLessThan(10);
  });

  it("keeps the demo board thin, the way a real one is", () => {
    // 30 games producing hundreds of qualifying bets would mean the scanner is
    // finding noise. A dozen or two is what a real slate looks like.
    const events = generateMockEvents({ seed: 21 });
    const found = scanForEv(events, {
      sharpBooks: ["pinnacle", "circasports", "betfair_ex_eu"],
      minEvPercent: 1,
    });
    expect(found.length).toBeGreaterThan(3);
    expect(found.length).toBeLessThan(events.length * 2);
  });

  it("flags the dead lines rather than presenting them as the best bets", () => {
    const found = scanForEv(generateMockEvents({ seed: 4 }), {
      sharpBooks: ["pinnacle", "circasports", "betfair_ex_eu"],
      minEvPercent: 1,
    });
    for (const o of found) {
      if (o.evPercent >= 12) expect(o.flags).toContain("stale-suspect");
      if (o.flags.includes("stale-suspect")) {
        expect(o.evPercent).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it("exposes the same fair line the odds screen renders", () => {
    // The odds screen looks fair prices up from fairLines(). If that ever
    // disagreed with what scanForEv priced against, the two screens would
    // quote different fair odds for one market.
    const events = generateMockEvents({ seed: 5 });
    const options = { sharpBooks: ["pinnacle", "circasports", "betfair_ex_eu"] };
    const lines = fairLines(events, options);
    const found = scanForEv(events, { ...options, minEvPercent: -100 });

    expect(found.length).toBeGreaterThan(20);
    for (const row of found) {
      const event = events.find((e) => e.id === row.eventId)!;
      const market = event.markets.find(
        (m) => m.bookmaker === row.book && m.marketKey === row.marketKey,
      )!;
      const outcome = market.outcomes.find((o) => outcomeKey(o) === row.outcomeKey)!;
      const line = lines.get(`${event.id}|${marketGroupKey(market, outcome)}`);
      expect(line, row.id).toBeDefined();
      expect(line!.probabilities.get(row.outcomeKey)).toBeCloseTo(row.fairProbability, 12);
    }
  });

  it("is more conservative under worst-case devigging than under multiplicative", () => {
    const events = generateMockEvents({ seed: 11 });
    const base = { sharpBooks: ["pinnacle"], minEvPercent: -100 };
    const multiplicative = scanForEv(events, { ...base, devigMethod: "multiplicative" });
    const worst = scanForEv(events, { ...base, devigMethod: "worstCase" });

    const byId = new Map(multiplicative.map((o) => [o.id, o.evPercent]));
    let compared = 0;
    for (const o of worst) {
      const other = byId.get(o.id);
      if (other === undefined) continue;
      compared++;
      expect(o.evPercent).toBeLessThanOrEqual(other + 1e-9);
    }
    expect(compared).toBeGreaterThan(20);
  });
});
