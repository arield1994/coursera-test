import { describe, expect, it } from "vitest";
import {
  americanToDecimal,
  decimalToAmerican,
  decimalToProbability,
  holdPercent,
  overround,
  probabilityToDecimal,
} from "../src/lib/odds/american";

describe("odds conversion", () => {
  it("converts the standard -110 vig price", () => {
    expect(americanToDecimal(-110)).toBeCloseTo(1.909091, 6);
    expect(americanToDecimal(100)).toBe(2);
    expect(americanToDecimal(150)).toBe(2.5);
    expect(americanToDecimal(-200)).toBe(1.5);
  });

  it("round-trips american -> decimal -> american", () => {
    for (const american of [-1000, -350, -110, -105, 100, 120, 250, 900]) {
      expect(decimalToAmerican(americanToDecimal(american))).toBeCloseTo(american, 9);
    }
  });

  it("treats +100 and -100 as the same even-money price", () => {
    expect(americanToDecimal(100)).toBe(americanToDecimal(-100));
  });

  it("round-trips probability and decimal", () => {
    for (const p of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      expect(decimalToProbability(probabilityToDecimal(p))).toBeCloseTo(p, 12);
    }
  });

  it("rejects prices that cannot pay out", () => {
    expect(Number.isNaN(americanToDecimal(0))).toBe(true);
    expect(Number.isNaN(decimalToAmerican(1))).toBe(true);
    expect(Number.isNaN(decimalToProbability(0.5))).toBe(true);
  });

  it("measures the overround of a standard -110/-110 market", () => {
    const prices = [americanToDecimal(-110), americanToDecimal(-110)];
    expect(overround(prices)).toBeCloseTo(1.047619, 6);
    // The familiar "4.5% hold" on a -110 two-way market.
    expect(holdPercent(prices)).toBeCloseTo(4.545, 3);
  });
});
