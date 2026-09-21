"use client";

import type { ArbLeg } from "@/lib/ev/arbitrage";
import { formatAmericanOdds, formatMoney } from "@/lib/format";

/** The two (or three) bets that make up an arb or a middle. */
export function LegList({ legs, currency = "$" }: { legs: ArbLeg[]; currency?: string }) {
  return (
    <div className="flex flex-col gap-1">
      {legs.map((leg, i) => (
        <div key={`${leg.book}-${i}`} className="flex items-baseline gap-2 text-[13px]">
          <span className="tnum w-20 shrink-0 text-right font-semibold">
            {formatMoney(leg.stake, currency)}
          </span>
          <span className="text-[var(--color-muted)]">on</span>
          <span className="font-medium">{leg.selection}</span>
          <span className="tnum text-[var(--color-text)]">
            {formatAmericanOdds(leg.american)}
          </span>
          <span className="text-[var(--color-faint)]">at {leg.bookTitle}</span>
        </div>
      ))}
    </div>
  );
}
