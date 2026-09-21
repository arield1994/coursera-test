"use client";

import { useMemo } from "react";
import { useLocalStorage } from "./useLocalStorage";
import { closingLineValue, settledProfit } from "@/lib/ev/ev";

export type BetResult = "pending" | "won" | "lost" | "push" | "void";

export interface TrackedBet {
  id: string;
  placedAt: string;
  sportTitle: string;
  matchup: string;
  marketName: string;
  selection: string;
  book: string;
  bookTitle: string;
  /** The price actually taken, in decimal. */
  decimal: number;
  stake: number;
  /** EV at the moment of placing — recorded, never recomputed. */
  evPercentAtBet: number;
  fairProbabilityAtBet: number;
  commenceTime: string;
  result: BetResult;
  /** Filled in after the game to measure closing line value. */
  closingDecimal?: number;
}

export interface BetStats {
  count: number;
  pending: number;
  settled: number;
  staked: number;
  profit: number;
  roi: number;
  /** Sum of EV at bet time — what the model said to expect. */
  expectedProfit: number;
  winRate: number;
  /** Mean CLV over bets with a recorded closing price. */
  averageClv: number | null;
  clvSampleSize: number;
  beatCloseRate: number | null;
}

export function useBets() {
  const { value: bets, setValue, hydrated } = useLocalStorage<TrackedBet[]>(
    "edgescan.bets.v1",
    [],
  );

  function addBet(bet: Omit<TrackedBet, "id" | "placedAt" | "result">) {
    setValue((current) => [
      {
        ...bet,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        placedAt: new Date().toISOString(),
        result: "pending" as const,
      },
      ...current,
    ]);
  }

  function updateBet(id: string, patch: Partial<TrackedBet>) {
    setValue((current) => current.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }

  function removeBet(id: string) {
    setValue((current) => current.filter((b) => b.id !== id));
  }

  function clearAll() {
    setValue([]);
  }

  const stats = useMemo<BetStats>(() => {
    const settled = bets.filter((b) => b.result !== "pending");
    const staked = settled.reduce((s, b) => s + b.stake, 0);
    const profit = settled.reduce(
      (s, b) => s + settledProfit(b.stake, b.decimal, b.result as Exclude<BetResult, "pending">),
      0,
    );

    // Pushes and voids return the stake, so they belong in neither the
    // numerator nor the denominator of a win rate.
    const decisive = settled.filter((b) => b.result === "won" || b.result === "lost");
    const won = decisive.filter((b) => b.result === "won").length;

    const withClosing = bets.filter(
      (b) => b.closingDecimal !== undefined && b.closingDecimal > 1,
    );
    const clvValues = withClosing
      .map((b) => closingLineValue(b.decimal, b.closingDecimal!))
      .filter((v): v is number => v !== null);

    return {
      count: bets.length,
      pending: bets.length - settled.length,
      settled: settled.length,
      staked,
      profit,
      roi: staked > 0 ? (profit / staked) * 100 : 0,
      expectedProfit: bets.reduce((s, b) => s + (b.stake * b.evPercentAtBet) / 100, 0),
      winRate: decisive.length > 0 ? (won / decisive.length) * 100 : 0,
      averageClv:
        clvValues.length > 0
          ? clvValues.reduce((s, v) => s + v, 0) / clvValues.length
          : null,
      clvSampleSize: clvValues.length,
      beatCloseRate:
        clvValues.length > 0
          ? (clvValues.filter((v) => v > 0).length / clvValues.length) * 100
          : null,
    };
  }, [bets]);

  return { bets, addBet, updateBet, removeBet, clearAll, stats, hydrated } as const;
}
