"use client";

import { useLocalStorage } from "./useLocalStorage";
import type { DevigMethod } from "@/lib/ev/devig";
import { DEFAULT_SHARP_BOOKS } from "@/lib/odds/books";
import { DEFAULT_MARKET_KEYS, DEFAULT_SPORT_KEYS } from "@/lib/providers";

export interface Settings {
  bankroll: number;
  kellyMultiplier: number;
  maxStakeFraction: number;
  devigMethod: DevigMethod;
  sharpBooks: string[];
  targetBooks: string[];
  sports: string[];
  markets: string[];
  minEvPercent: number;
  maxEvPercent: number;
  minSharpBooks: number;
  maxHoursAhead: number;
  refreshSeconds: number;
  autoRefresh: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  bankroll: 1000,
  // Quarter Kelly. Full Kelly assumes the fair line is exact; it never is.
  kellyMultiplier: 0.25,
  maxStakeFraction: 0.05,
  devigMethod: "worstCase",
  sharpBooks: DEFAULT_SHARP_BOOKS,
  targetBooks: [],
  sports: DEFAULT_SPORT_KEYS,
  markets: DEFAULT_MARKET_KEYS,
  minEvPercent: 1,
  maxEvPercent: 40,
  minSharpBooks: 1,
  maxHoursAhead: 0,
  refreshSeconds: 30,
  autoRefresh: true,
};

export function useSettings() {
  const { value, setValue, hydrated, reset } = useLocalStorage<Settings>(
    "edgescan.settings.v1",
    DEFAULT_SETTINGS,
  );

  // Merge over defaults so a settings blob saved by an older build — missing
  // keys added since — doesn't leave fields undefined.
  const settings: Settings = { ...DEFAULT_SETTINGS, ...value };

  function update(patch: Partial<Settings>) {
    setValue((current) => ({ ...DEFAULT_SETTINGS, ...current, ...patch }));
  }

  return { settings, update, hydrated, reset } as const;
}

/** Turn settings into the query string the scan endpoints expect. */
export function scanQuery(settings: Settings): string {
  const params = new URLSearchParams({
    sports: settings.sports.join(","),
    markets: settings.markets.join(","),
    sharp: settings.sharpBooks.join(","),
    devig: settings.devigMethod,
    minEv: String(settings.minEvPercent),
    maxEv: String(settings.maxEvPercent),
    minSharp: String(settings.minSharpBooks),
    maxHours: String(settings.maxHoursAhead),
    bankroll: String(settings.bankroll),
    kelly: String(settings.kellyMultiplier),
    maxStake: String(settings.maxStakeFraction),
  });
  if (settings.targetBooks.length > 0) {
    params.set("books", settings.targetBooks.join(","));
  }
  return params.toString();
}
