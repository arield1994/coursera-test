"use client";

import { useState } from "react";
import { Badge, Button, EmptyState, Input, Select, Stat } from "@/components/ui";
import { useBets, type BetResult } from "@/hooks/useBets";
import { closingLineValue, settledProfit } from "@/lib/ev/ev";
import { americanToDecimal, decimalToAmerican } from "@/lib/odds/american";
import {
  formatAmericanOdds,
  formatClock,
  formatMoney,
  formatPercent,
  formatPlainPercent,
} from "@/lib/format";

const RESULTS: BetResult[] = ["pending", "won", "lost", "push", "void"];

export default function TrackerPage() {
  const { bets, updateBet, removeBet, clearAll, stats, hydrated } = useBets();
  const [closingInput, setClosingInput] = useState<Record<string, string>>({});

  if (!hydrated) {
    return <p className="text-sm text-[var(--color-muted)]">Loading your bets…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Bet tracker</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--color-muted)]">
          Bets you log from the scanner, with the edge recorded as it was at the
          time. Whether a bet won is mostly noise over any sample you will
          actually have; whether you beat the closing line is the measure that
          converges quickly — so record closing prices and watch that number.
          Everything here is stored in this browser only.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Profit"
          value={formatMoney(stats.profit)}
          tone={stats.profit > 0 ? "good" : stats.profit < 0 ? "bad" : "neutral"}
          hint={`${stats.settled} settled · ${stats.pending} pending`}
        />
        <Stat
          label="ROI"
          value={formatPercent(stats.roi)}
          tone={stats.roi > 0 ? "good" : stats.roi < 0 ? "bad" : "neutral"}
          hint={`${formatMoney(stats.staked)} staked`}
        />
        <Stat
          label="Expected profit"
          value={formatMoney(stats.expectedProfit)}
          hint="Sum of edge at bet time"
        />
        <Stat
          label="Average CLV"
          value={stats.averageClv === null ? "—" : formatPercent(stats.averageClv)}
          tone={
            stats.averageClv === null
              ? "neutral"
              : stats.averageClv > 0
                ? "good"
                : "bad"
          }
          hint={
            stats.clvSampleSize > 0
              ? `${stats.clvSampleSize} priced · beat close ${formatPlainPercent(stats.beatCloseRate ?? 0)}`
              : "Add closing prices below"
          }
        />
      </div>

      {bets.length === 0 ? (
        <div className="rounded-lg border border-[var(--color-line)]">
          <EmptyState
            title="No bets logged yet"
            body="Use Log bet on the scanner to record a play here with its edge, stake and price."
          />
        </div>
      ) : (
        <>
          <div className="flex justify-end">
            <Button
              variant="danger"
              onClick={() => {
                if (window.confirm("Delete every logged bet? This cannot be undone.")) {
                  clearAll();
                }
              }}
            >
              Clear all
            </Button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-[var(--color-line)]">
            <table className="w-full min-w-[1100px] border-collapse text-sm">
              <thead className="bg-[var(--color-surface-2)] text-[11px] uppercase tracking-wider text-[var(--color-faint)]">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Bet</th>
                  <th className="px-3 py-2 text-left font-medium">Book</th>
                  <th className="px-3 py-2 text-right font-medium">Price</th>
                  <th className="px-3 py-2 text-right font-medium">Stake</th>
                  <th className="px-3 py-2 text-right font-medium">Edge</th>
                  <th className="px-3 py-2 text-left font-medium">Closing</th>
                  <th className="px-3 py-2 text-right font-medium">CLV</th>
                  <th className="px-3 py-2 text-left font-medium">Result</th>
                  <th className="px-3 py-2 text-right font-medium">P/L</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>

              <tbody>
                {bets.map((bet) => {
                  const clv =
                    bet.closingDecimal !== undefined
                      ? closingLineValue(bet.decimal, bet.closingDecimal)
                      : null;
                  const profit =
                    bet.result === "pending"
                      ? null
                      : settledProfit(bet.stake, bet.decimal, bet.result);

                  return (
                    <tr key={bet.id} className="border-t border-[var(--color-line)]">
                      <td className="px-3 py-2">
                        <div className="text-[13px] font-medium">{bet.selection}</div>
                        <div className="text-[11px] text-[var(--color-faint)]">
                          {bet.matchup} · {bet.marketName} · {formatClock(bet.commenceTime)}
                        </div>
                      </td>

                      <td className="px-3 py-2 whitespace-nowrap text-[13px]">
                        {bet.bookTitle}
                      </td>

                      <td className="tnum px-3 py-2 text-right text-[13px]">
                        {formatAmericanOdds(decimalToAmerican(bet.decimal))}
                      </td>

                      <td className="tnum px-3 py-2 text-right text-[13px]">
                        {formatMoney(bet.stake)}
                      </td>

                      <td className="tnum px-3 py-2 text-right text-[13px] text-[var(--color-edge)]">
                        {formatPercent(bet.evPercentAtBet)}
                      </td>

                      <td className="px-3 py-2">
                        <Input
                          className="w-24"
                          placeholder="-110"
                          value={
                            closingInput[bet.id] ??
                            (bet.closingDecimal
                              ? String(Math.round(decimalToAmerican(bet.closingDecimal)))
                              : "")
                          }
                          onChange={(e) =>
                            setClosingInput((c) => ({ ...c, [bet.id]: e.target.value }))
                          }
                          onBlur={(e) => {
                            const raw = e.target.value.trim();
                            if (raw === "") {
                              updateBet(bet.id, { closingDecimal: undefined });
                              return;
                            }
                            const decimal = americanToDecimal(Number(raw));
                            // Ignore unparseable input rather than storing NaN,
                            // which would poison the CLV average.
                            if (Number.isFinite(decimal)) {
                              updateBet(bet.id, { closingDecimal: decimal });
                            }
                          }}
                        />
                      </td>

                      <td
                        className={`tnum px-3 py-2 text-right text-[13px] ${
                          clv === null
                            ? "text-[var(--color-faint)]"
                            : clv > 0
                              ? "text-[var(--color-edge)]"
                              : "text-[var(--color-danger)]"
                        }`}
                      >
                        {clv === null ? "—" : formatPercent(clv)}
                      </td>

                      <td className="px-3 py-2">
                        <Select
                          className="w-28"
                          value={bet.result}
                          onChange={(e) =>
                            updateBet(bet.id, { result: e.target.value as BetResult })
                          }
                        >
                          {RESULTS.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </Select>
                      </td>

                      <td
                        className={`tnum px-3 py-2 text-right text-[13px] ${
                          profit === null
                            ? "text-[var(--color-faint)]"
                            : profit > 0
                              ? "text-[var(--color-edge)]"
                              : profit < 0
                                ? "text-[var(--color-danger)]"
                                : "text-[var(--color-muted)]"
                        }`}
                      >
                        {profit === null ? (
                          <Badge>open</Badge>
                        ) : (
                          formatMoney(profit)
                        )}
                      </td>

                      <td className="px-3 py-2 text-right">
                        <Button variant="ghost" onClick={() => removeBet(bet.id)}>
                          Remove
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
