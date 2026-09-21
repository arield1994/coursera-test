import { describe, expect, it } from "vitest";
import { americanToDecimal } from "../src/lib/odds/american";
import { closingLineValue, computeEv, settledProfit } from "../src/lib/ev/ev";

describe("expected value", () => {
  it("prices a coin flip offered at plus money", () => {
    // Fair 50/50, offered +105. EV = 0.5 * 2.05 - 1 = +2.5%.
    const ev = computeEv(0.5, americanToDecimal(105), {
      bankroll: 1000,
      kellyMultiplier: 0.25,
    })!;
    expect(ev.evPercent).toBeCloseTo(2.5, 10);
    expect(ev.fairAmerican).toBeCloseTo(100, 10);
    // Kelly = edge / (decimal - 1) = 0.025 / 1.05.
    expect(ev.kellyFraction).toBeCloseTo(0.025 / 1.05, 12);
    expect(ev.stake).toBeCloseTo(5.95, 2);
  });

  it("reports negative EV on the wrong side of the same market", () => {
    const ev = computeEv(0.5, americanToDecimal(-125))!;
    expect(ev.evPercent).toBeCloseTo(-10, 10);
    expect(ev.kellyFraction).toBeLessThan(0);
    // Kelly says bet nothing, never a negative stake.
    expect(ev.stake).toBe(0);
  });

  it("caps the stake regardless of what Kelly asks for", () => {
    const ev = computeEv(0.9, americanToDecimal(100), {
      bankroll: 1000,
      kellyMultiplier: 1,
      maxStakeFraction: 0.05,
    })!;
    expect(ev.kellyFraction).toBeCloseTo(0.8, 10);
    expect(ev.stakeFraction).toBe(0.05);
    expect(ev.stake).toBe(50);
  });

  it("scales the stake with the Kelly multiplier", () => {
    const full = computeEv(0.55, 2, { bankroll: 1000, kellyMultiplier: 1 })!;
    const quarter = computeEv(0.55, 2, { bankroll: 1000, kellyMultiplier: 0.25 })!;
    expect(full.kellyFraction).toBeCloseTo(0.1, 10);
    expect(quarter.stakeFraction).toBeCloseTo(full.stakeFraction / 4, 12);
  });

  it("rejects impossible inputs", () => {
    expect(computeEv(0, 2)).toBeNull();
    expect(computeEv(1, 2)).toBeNull();
    expect(computeEv(0.5, 1)).toBeNull();
    expect(computeEv(Number.NaN, 2)).toBeNull();
  });
});

describe("closing line value", () => {
  it("is positive when the bet beat the close", () => {
    expect(closingLineValue(americanToDecimal(110), americanToDecimal(-110))!)
      .toBeCloseTo((2.1 / (1 + 100 / 110) - 1) * 100, 6);
    expect(closingLineValue(2.1, 2.0)!).toBeCloseTo(5, 10);
    expect(closingLineValue(2.0, 2.1)!).toBeCloseTo(-4.7619, 4);
  });

  it("rejects prices that cannot close", () => {
    expect(closingLineValue(1, 2)).toBeNull();
    expect(closingLineValue(2, Number.NaN)).toBeNull();
  });
});

describe("settlement", () => {
  it("returns profit, not total return", () => {
    expect(settledProfit(100, 2.5, "won")).toBe(150);
    expect(settledProfit(100, 2.5, "lost")).toBe(-100);
    expect(settledProfit(100, 2.5, "push")).toBe(0);
    expect(settledProfit(100, 2.5, "void")).toBe(0);
  });
});
