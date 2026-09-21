import { describe, expect, it } from "vitest";
import { americanToDecimal } from "../src/lib/odds/american";
import {
  DEVIG_METHODS,
  consensusProbabilities,
  devig,
  type DevigMethod,
} from "../src/lib/ev/devig";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("devig", () => {
  const balanced = [americanToDecimal(-110), americanToDecimal(-110)];
  // A lopsided market is where the methods actually disagree.
  const lopsided = [americanToDecimal(-450), americanToDecimal(340)];
  const threeWay = [
    americanToDecimal(130),
    americanToDecimal(240),
    americanToDecimal(210),
  ];

  it("returns a valid distribution for every method that claims to be one", () => {
    for (const method of DEVIG_METHODS) {
      for (const market of [balanced, lopsided, threeWay]) {
        const result = devig(market, method);
        expect(result, `${method}`).not.toBeNull();
        expect(result!.probabilities.every((p) => p > 0 && p < 1)).toBe(true);
        if (result!.isDistribution) {
          expect(sum(result!.probabilities), `${method}`).toBeCloseTo(1, 10);
        } else {
          // worstCase returns independent per-side lower bounds.
          expect(sum(result!.probabilities), `${method}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("flags worst case as a bound vector rather than a distribution", () => {
    expect(devig(lopsided, "worstCase")!.isDistribution).toBe(false);
    expect(sum(devig(lopsided, "worstCase")!.probabilities)).toBeLessThan(1);
    for (const method of ["multiplicative", "additive", "power", "shin"] as DevigMethod[]) {
      expect(devig(lopsided, method)!.isDistribution, method).toBe(true);
    }
  });

  it("makes a symmetric market exactly 50/50", () => {
    for (const method of DEVIG_METHODS) {
      const result = devig(balanced, method)!;
      expect(result.probabilities[0], method).toBeCloseTo(0.5, 9);
      expect(result.probabilities[1], method).toBeCloseTo(0.5, 9);
    }
  });

  it("reports the overround it stripped", () => {
    expect(devig(balanced, "multiplicative")!.overround).toBeCloseTo(1.047619, 6);
  });

  it("solves the power exponent so the transformed probabilities sum to one", () => {
    const raw = lopsided.map((d) => 1 / d);
    const fair = devig(lopsided, "power")!.probabilities;
    // Recover k from any single outcome and confirm it reproduces the others.
    const k = Math.log(fair[0]) / Math.log(raw[0]);
    expect(sum(raw.map((p) => Math.pow(p, k)))).toBeCloseTo(1, 6);
  });

  it("strips more margin from the longshot than multiplicative does", () => {
    // Books load margin onto longshots. Multiplicative removes the same
    // proportion everywhere and so leaves the longshot over-credited, which is
    // exactly how naive scanners manufacture fake edges on plus-money dogs.
    const longshot = 1;
    const multiplicative = devig(lopsided, "multiplicative")!.probabilities[longshot];
    expect(devig(lopsided, "power")!.probabilities[longshot]).toBeLessThan(multiplicative);
    expect(devig(lopsided, "shin")!.probabilities[longshot]).toBeLessThan(multiplicative);
    // The favourite is the mirror image: it gets credited more, not less.
    expect(devig(lopsided, "power")!.probabilities[0]).toBeGreaterThan(
      devig(lopsided, "multiplicative")!.probabilities[0],
    );
  });

  it("matches the additive solution on two-way markets and diverges on three-way", () => {
    // A genuine algebraic identity for n = 2, not a fallback: choosing Shin
    // over additive on a moneyline changes nothing.
    for (const market of [balanced, lopsided]) {
      const shin = devig(market, "shin")!.probabilities;
      const additive = devig(market, "additive")!.probabilities;
      shin.forEach((p, i) => expect(p).toBeCloseTo(additive[i], 9));
    }
    const shin3 = devig(threeWay, "shin")!.probabilities;
    const additive3 = devig(threeWay, "additive")!.probabilities;
    expect(Math.abs(shin3[0] - additive3[0])).toBeGreaterThan(1e-6);
  });

  it("worst case is never more generous than any individual method", () => {
    const others: DevigMethod[] = ["multiplicative", "additive", "power", "shin"];
    for (const market of [balanced, lopsided, threeWay]) {
      const worst = devig(market, "worstCase")!.probabilities;
      for (const method of others) {
        const result = devig(market, method);
        if (!result) continue;
        expect(result.probabilities.length).toBe(worst.length);
        // Every side must be bounded below the method's own estimate: a lower
        // fair probability means a lower computed EV.
        result.probabilities.forEach((p, i) => {
          expect(worst[i]).toBeLessThanOrEqual(p + 1e-12);
        });
      }
    }
  });

  it("refuses markets it cannot devig", () => {
    expect(devig([1.91], "power")).toBeNull();
    expect(devig([1.0, 1.91], "power")).toBeNull();
    expect(devig([Number.NaN, 2], "power")).toBeNull();
  });

  it("does not inflate a sub-100% market (that is an arb, not vig)", () => {
    const arb = [2.2, 2.2]; // sums to 90.9%
    const result = devig(arb, "multiplicative")!;
    expect(result.overround).toBeLessThan(1);
    expect(sum(result.probabilities)).toBeCloseTo(1, 10);
  });

  it("preserves worst-case bounds through the consensus blend", () => {
    // Renormalising a blend of bound vectors would scale them back up and undo
    // the conservatism -- worth about two points of phantom EV per market.
    const bounds = devig(lopsided, "worstCase")!.probabilities;
    const blended = consensusProbabilities([{ probabilities: bounds, weight: 1 }], false)!;
    expect(sum(blended)).toBeCloseTo(sum(bounds), 12);
    expect(sum(blended)).toBeLessThan(1);

    const renormalized = consensusProbabilities([{ probabilities: bounds, weight: 1 }], true)!;
    expect(sum(renormalized)).toBeCloseTo(1, 12);
    expect(renormalized[0]).toBeGreaterThan(blended[0]);
  });

  it("weights the consensus toward the heavier book", () => {
    const blended = consensusProbabilities([
      { probabilities: [0.6, 0.4], weight: 3 },
      { probabilities: [0.4, 0.6], weight: 1 },
    ])!;
    expect(blended[0]).toBeCloseTo(0.55, 10);
    expect(sum(blended)).toBeCloseTo(1, 12);
  });

  it("rejects a consensus over mismatched market widths", () => {
    expect(
      consensusProbabilities([
        { probabilities: [0.5, 0.5], weight: 1 },
        { probabilities: [0.3, 0.3, 0.4], weight: 1 },
      ]),
    ).toBeNull();
  });
});
