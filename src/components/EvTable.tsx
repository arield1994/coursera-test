"use client";

import { useState } from "react";
import { Badge, Button, EmptyState } from "./ui";
import type { EvOpportunity } from "@/lib/ev/scanner";
import { bookTitle } from "@/lib/odds/books";
import {
  formatAge,
  formatAmericanOdds,
  formatClock,
  formatKickoff,
  formatMoney,
  formatPercent,
  formatPlainPercent,
} from "@/lib/format";

const FLAG_LABELS: Record<string, { label: string; tone: "warn" | "bad" | "info"; title: string }> = {
  "stale-suspect": {
    label: "check",
    tone: "warn",
    title:
      "This edge is large enough that the price is probably stale or the market has moved. Verify before betting.",
  },
  "high-hold": {
    label: "wide",
    tone: "warn",
    title:
      "The sharp market behind this fair line carries an unusually large margin, so the estimate is less reliable.",
  },
  "thin-consensus": {
    label: "1 book",
    tone: "info",
    title: "Only one sharp book priced this market, so there is nothing to cross-check it against.",
  },
  "starting-soon": {
    label: "soon",
    tone: "bad",
    title: "This event starts in under 15 minutes.",
  },
};

type SortKey = "evPercent" | "stake" | "commenceTime" | "american";

export function EvTable({
  rows,
  currency = "$",
  onLogBet,
}: {
  rows: EvOpportunity[];
  currency?: string;
  onLogBet?: (row: EvOpportunity) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("evPercent");
  const [ascending, setAscending] = useState(false);
  const [logged, setLogged] = useState<Set<string>>(new Set());

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No qualifying bets right now"
        body={
          <>
            That is the normal state of a +EV board. Try lowering the minimum
            edge, widening the sports or markets, or switching to a less
            conservative de-vig method — but treat a board full of edges as a
            sign something is wrong, not as a windfall.
          </>
        }
      />
    );
  }

  const sorted = [...rows].sort((a, b) => {
    const direction = ascending ? 1 : -1;
    if (sortKey === "commenceTime") {
      return (Date.parse(a.commenceTime) - Date.parse(b.commenceTime)) * direction;
    }
    return (a[sortKey] - b[sortKey]) * direction;
  });

  function toggleSort(key: SortKey) {
    if (key === sortKey) setAscending((v) => !v);
    else {
      setSortKey(key);
      setAscending(false);
    }
  }

  function header(key: SortKey, label: string, align = "text-left") {
    return (
      <th className={`${align} px-3 py-2 font-medium`}>
        <button
          type="button"
          onClick={() => toggleSort(key)}
          className="inline-flex items-center gap-1 hover:text-[var(--color-text)]"
        >
          {label}
          {sortKey === key && <span className="text-[9px]">{ascending ? "▲" : "▼"}</span>}
        </button>
      </th>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--color-line)]">
      <table className="w-full min-w-[1080px] border-collapse text-sm">
        <thead className="bg-[var(--color-surface-2)] text-[11px] uppercase tracking-wider text-[var(--color-faint)]">
          <tr>
            {header("evPercent", "Edge", "text-right")}
            <th className="px-3 py-2 text-left font-medium">Game</th>
            {header("commenceTime", "Starts")}
            <th className="px-3 py-2 text-left font-medium">Market</th>
            <th className="px-3 py-2 text-left font-medium">Bet</th>
            <th className="px-3 py-2 text-left font-medium">Book</th>
            {header("american", "Price", "text-right")}
            <th className="px-3 py-2 text-right font-medium">Fair</th>
            {header("stake", "Stake", "text-right")}
            <th className="px-3 py-2 text-left font-medium">Best</th>
            {onLogBet && <th className="px-3 py-2" />}
          </tr>
        </thead>

        <tbody>
          {sorted.map((row) => {
            const beatenByAnotherBook = row.bestAvailableDecimal > row.decimal + 1e-9;
            return (
              <tr
                key={row.id}
                className="border-t border-[var(--color-line)] align-middle hover:bg-[var(--color-surface-2)]/60"
              >
                <td className="tnum px-3 py-2 text-right font-semibold text-[var(--color-edge)]">
                  {formatPercent(row.evPercent)}
                </td>

                <td className="px-3 py-2">
                  <div className="whitespace-nowrap text-[13px] text-[var(--color-text)]">
                    {row.matchup}
                  </div>
                  <div className="text-[11px] text-[var(--color-faint)]">{row.sportTitle}</div>
                </td>

                <td className="px-3 py-2 whitespace-nowrap">
                  <div className="tnum text-[13px]">{formatKickoff(row.commenceTime)}</div>
                  <div className="text-[11px] text-[var(--color-faint)]">
                    {formatClock(row.commenceTime)}
                  </div>
                </td>

                <td className="px-3 py-2 whitespace-nowrap text-[13px] text-[var(--color-muted)]">
                  {row.marketName}
                </td>

                <td className="px-3 py-2">
                  <div className="whitespace-nowrap text-[13px] font-medium">{row.selection}</div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {row.flags.map((flag) => {
                      const meta = FLAG_LABELS[flag];
                      if (!meta) return null;
                      return (
                        <Badge key={flag} tone={meta.tone} title={meta.title}>
                          {meta.label}
                        </Badge>
                      );
                    })}
                  </div>
                </td>

                <td className="px-3 py-2 whitespace-nowrap">
                  <div className="text-[13px]">{row.bookTitle}</div>
                  <div className="text-[11px] text-[var(--color-faint)]">
                    {formatAge(row.lastUpdate)}
                  </div>
                </td>

                <td className="tnum px-3 py-2 text-right text-[13px] font-semibold">
                  {formatAmericanOdds(row.american)}
                </td>

                <td className="tnum px-3 py-2 text-right text-[13px] text-[var(--color-muted)]">
                  <div>{formatAmericanOdds(row.fairAmerican)}</div>
                  <div className="text-[11px] text-[var(--color-faint)]">
                    {formatPlainPercent(row.fairProbability * 100)}
                  </div>
                </td>

                <td className="tnum px-3 py-2 text-right text-[13px]">
                  <div>{formatMoney(row.stake, currency)}</div>
                  <div className="text-[11px] text-[var(--color-faint)]">
                    {formatPlainPercent(row.stakeFraction * 100, 2)} roll
                  </div>
                </td>

                <td className="px-3 py-2 whitespace-nowrap text-[12px]">
                  {beatenByAnotherBook ? (
                    <span className="text-[var(--color-warn)]">
                      {bookTitle(row.bestAvailableBook)}
                    </span>
                  ) : (
                    <span className="text-[var(--color-faint)]">best price</span>
                  )}
                </td>

                {onLogBet && (
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant={logged.has(row.id) ? "ghost" : "primary"}
                      disabled={logged.has(row.id)}
                      onClick={() => {
                        onLogBet(row);
                        setLogged((current) => new Set(current).add(row.id));
                      }}
                    >
                      {logged.has(row.id) ? "Logged" : "Log bet"}
                    </Button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
