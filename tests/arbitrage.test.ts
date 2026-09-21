import { describe, expect, it } from "vitest";
import { findArbitrage, findMiddles } from "../src/lib/ev/arbitrage";
import { generateMockEvents } from "../src/lib/providers/mock";
import { event, market } from "./fixtures";

describe("arbitrage", () => {
  it("locks a profit when both sides pay better than even money", () => {
    const events = [
      event([
        market("draftkings", "h2h", [
          { name: "Chiefs", price: 2.2 },
          { name: "Bills", price: 1.6 },
        ]),
        market("betmgm", "h2h", [
          { name: "Chiefs", price: 1.6 },
          { name: "Bills", price: 2.2 },
        ]),
      ]),
    ];

    const [arb] = findArbitrage(events, { totalStake: 1000 });
    // Best of each side is 2.2 / 2.2 => 90.909% implied => 10% return.
    expect(arb.profitPercent).toBeCloseTo(10, 6);
    expect(arb.guaranteedProfit).toBeCloseTo(100, 2);
    expect(arb.legs).toHaveLength(2);
    expect(arb.legs.map((l) => l.book).sort()).toEqual(["betmgm", "draftkings"]);
    expect(arb.legs[0].stake + arb.legs[1].stake).toBeCloseTo(1000, 2);

    // The defining property: identical return whichever side wins.
    for (const leg of arb.legs) {
      expect(leg.stake * leg.decimal).toBeCloseTo(1100, 1);
    }
  });

  it("does not report a market that still has vig in it", () => {
    const events = [
      event([
        market("draftkings", "h2h", [
          { name: "Chiefs", price: 1.91 },
          { name: "Bills", price: 1.91 },
        ]),
        market("betmgm", "h2h", [
          { name: "Chiefs", price: 1.95 },
          { name: "Bills", price: 1.88 },
        ]),
      ]),
    ];
    expect(findArbitrage(events)).toHaveLength(0);
  });

  it("rejects an 'arb' that lives entirely at one book", () => {
    const events = [
      event([
        market("draftkings", "h2h", [
          { name: "Chiefs", price: 2.2 },
          { name: "Bills", price: 2.2 },
        ]),
      ]),
    ];
    expect(findArbitrage(events)).toHaveLength(0);
  });

  it("does not pair two different lines as if they were one market", () => {
    const events = [
      event([
        market("draftkings", "totals", [
          { name: "Over", price: 2.2, point: 45.5 },
          { name: "Under", price: 1.6, point: 45.5 },
        ]),
        market("betmgm", "totals", [
          { name: "Over", price: 1.6, point: 48.5 },
          { name: "Under", price: 2.2, point: 48.5 },
        ]),
      ]),
    ];
    // Over 45.5 and Under 48.5 both paying 2.2 is a *middle*, not an arb:
    // a total of 46, 47 or 48 wins both, but 50 loses one and 44 loses the other.
    expect(findArbitrage(events)).toHaveLength(0);
  });

  it("discards implausibly large arbs as stale prices", () => {
    const events = [
      event([
        market("draftkings", "h2h", [{ name: "Chiefs", price: 2.6 }, { name: "Bills", price: 1.2 }]),
        market("betmgm", "h2h", [{ name: "Chiefs", price: 1.2 }, { name: "Bills", price: 2.6 }]),
      ]),
    ];
    // Best of each side is 2.6 / 2.6 => 76.9% implied => a 30% "arb", which in
    // practice means one of the two prices is already dead.
    expect(findArbitrage(events, { maxProfitPercent: 15 })).toHaveLength(0);
    const [loud] = findArbitrage(events, { maxProfitPercent: 100 });
    expect(loud.profitPercent).toBeCloseTo(30, 6);
  });

  it("stays quiet on the demo board, as a real one mostly does", () => {
    const arbs = findArbitrage(generateMockEvents({ seed: 3 }), { minProfitPercent: 0.25 });
    for (const arb of arbs) {
      expect(arb.profitPercent).toBeGreaterThan(0);
      expect(new Set(arb.legs.map((l) => l.book)).size).toBeGreaterThan(1);
      const returns = arb.legs.map((l) => l.stake * l.decimal);
      expect(Math.max(...returns) - Math.min(...returns)).toBeLessThan(1);
    }
  });
});

describe("middles", () => {
  it("finds the window where both sides cash", () => {
    const events = [
      event([
        market("draftkings", "totals", [
          { name: "Over", price: 1.95, point: 45.5 },
          { name: "Under", price: 1.95, point: 45.5 },
        ]),
        market("betmgm", "totals", [
          { name: "Over", price: 1.95, point: 48.5 },
          { name: "Under", price: 1.95, point: 48.5 },
        ]),
      ]),
    ];

    const middles = findMiddles(events, { totalStake: 1000 });
    expect(middles.length).toBeGreaterThan(0);
    const best = middles[0];
    // Over 45.5 at one book, Under 48.5 at the other: 46, 47, 48 win both.
    expect(best.lowLine).toBe(45.5);
    expect(best.highLine).toBe(48.5);
    expect(best.windowWidth).toBe(3);
    expect(best.legs.map((l) => l.book).sort()).toEqual(["betmgm", "draftkings"]);
    // At -105 a side the middle costs a little to hold but pays far more if it lands.
    expect(best.costPercent).toBeGreaterThan(0);
    expect(best.hitReturnPercent).toBeGreaterThan(best.costPercent);
  });

  it("ignores inverted pairs that cannot middle", () => {
    const events = [
      event([
        market("draftkings", "totals", [
          { name: "Over", price: 1.95, point: 48.5 },
          { name: "Under", price: 1.95, point: 48.5 },
        ]),
        market("betmgm", "totals", [
          { name: "Over", price: 1.95, point: 45.5 },
          { name: "Under", price: 1.95, point: 45.5 },
        ]),
      ]),
    ];
    // Over 48.5 + Under 45.5 is a gap, not a middle: nothing wins both.
    const middles = findMiddles(events, { minWindowWidth: 0.5 });
    expect(middles.every((m) => m.highLine > m.lowLine)).toBe(true);
  });

  it("finds middles on the demo board, because books there disagree on the number", () => {
    // Middles are only possible when books hang different lines. If the demo
    // feed ever went back to giving every book the same number this would
    // silently return nothing and the middles screen would look broken.
    const events = generateMockEvents({ seed: 2 });

    const totalsLines = new Set<number>();
    for (const event of events) {
      for (const market of event.markets) {
        if (market.marketKey !== "totals" || event.id !== events[0].id) continue;
        for (const outcome of market.outcomes) {
          if (outcome.point !== undefined) totalsLines.add(outcome.point);
        }
      }
    }
    expect(totalsLines.size).toBeGreaterThan(1);

    const middles = findMiddles(events, { maxCostPercent: 6, minWindowWidth: 0.5 });
    expect(middles.length).toBeGreaterThan(0);
    for (const middle of middles) {
      expect(middle.highLine).toBeGreaterThan(middle.lowLine);
      expect(middle.legs[0].book).not.toBe(middle.legs[1].book);
      expect(middle.legs[0].stake + middle.legs[1].stake).toBeCloseTo(500, 1);
    }
  });

  it("rejects middles that cost too much to hold", () => {
    const events = [
      event([
        market("draftkings", "totals", [
          { name: "Over", price: 1.5, point: 45.5 },
          { name: "Under", price: 1.5, point: 45.5 },
        ]),
        market("betmgm", "totals", [
          { name: "Over", price: 1.5, point: 47.5 },
          { name: "Under", price: 1.5, point: 47.5 },
        ]),
      ]),
    ];
    expect(findMiddles(events, { maxCostPercent: 8 })).toHaveLength(0);
  });
});
