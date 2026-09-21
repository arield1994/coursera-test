"use client";

import { useMemo, useState } from "react";
import { FeedStatus } from "@/components/FeedStatus";
import { EmptyState, Field, Select } from "@/components/ui";
import { useFeed } from "@/hooks/useFeed";
import { useSettings } from "@/hooks/useSettings";
import { bookProfile } from "@/lib/odds/books";
import {
  type GameEvent,
  describeOutcome,
  marketGroupKey,
  marketLabel,
  outcomeKey,
} from "@/lib/odds/types";
import { fairLines, type FairLine } from "@/lib/ev/scanner";
import { formatAmericanOdds, formatClock, formatKickoff, formatPlainPercent } from "@/lib/format";
import { decimalToAmerican } from "@/lib/odds/american";

interface Cell {
  decimal: number;
  american: number;
}

interface Row {
  key: string;
  label: string;
  byBook: Map<string, Cell>;
  bestDecimal: number;
  fairProbability: number | null;
}

/**
 * Reshape one event into a side-by-side price grid for a single market.
 *
 * The fair column is looked up from the scanner's own consensus fair lines
 * rather than recomputed here, so this screen and the scanner can never quote
 * two different fair prices for the same market.
 */
function buildGrid(
  event: GameEvent,
  marketKey: string,
  lines: Map<string, FairLine>,
) {
  const rows = new Map<string, Row>();
  const books = new Set<string>();

  for (const market of event.markets) {
    if (market.marketKey !== marketKey) continue;
    books.add(market.bookmaker);

    for (const outcome of market.outcomes) {
      const groupKey = marketGroupKey(market, outcome);
      const key = `${groupKey}::${outcomeKey(outcome)}`;

      let row = rows.get(key);
      if (!row) {
        const fair = lines.get(`${event.id}|${groupKey}`);
        rows.set(
          key,
          (row = {
            key,
            label: describeOutcome(outcome, marketKey),
            byBook: new Map(),
            bestDecimal: 0,
            fairProbability: fair?.probabilities.get(outcomeKey(outcome)) ?? null,
          }),
        );
      }

      row.byBook.set(market.bookmaker, {
        decimal: outcome.price,
        american: decimalToAmerican(outcome.price),
      });
      row.bestDecimal = Math.max(row.bestDecimal, outcome.price);
    }
  }

  const orderedBooks = [...books].sort((a, b) => {
    const pa = bookProfile(a);
    const pb = bookProfile(b);
    // Sharp books first -- they are the reference you read the rest against.
    if (pa.sharp !== pb.sharp) return pa.sharp ? -1 : 1;
    return pa.title.localeCompare(pb.title);
  });

  return { rows: [...rows.values()], books: orderedBooks };
}

export default function OddsScreenPage() {
  const { settings, hydrated } = useSettings();
  const [marketKey, setMarketKey] = useState("h2h");

  const query = useMemo(
    () =>
      new URLSearchParams({
        sports: settings.sports.join(","),
        markets: settings.markets.join(","),
      }).toString(),
    [settings.sports, settings.markets],
  );

  const feed = useFeed<GameEvent>("/api/odds", query, {
    enabled: hydrated && settings.autoRefresh,
    intervalMs: settings.refreshSeconds * 1000,
  });

  const lines = useMemo(
    () =>
      fairLines(feed.data, {
        sharpBooks: settings.sharpBooks,
        devigMethod: settings.devigMethod,
        minSharpBooks: settings.minSharpBooks,
      }),
    [feed.data, settings.sharpBooks, settings.devigMethod, settings.minSharpBooks],
  );

  const upcoming = useMemo(
    () =>
      [...feed.data]
        .filter((e) => Date.parse(e.commenceTime) > Date.now())
        .sort((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime))
        .slice(0, 25),
    [feed.data],
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Odds screen</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--color-muted)]">
          Every book&apos;s price side by side, with the sharp de-vigged fair
          probability alongside. Best price on each side is highlighted —
          consistently taking it is worth more over a season than most people
          expect.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 sm:w-64">
          <Field label="Market">
            <Select value={marketKey} onChange={(e) => setMarketKey(e.target.value)}>
              {settings.markets.map((m) => (
                <option key={m} value={m}>
                  {marketLabel(m)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {settings.devigMethod === "worstCase" && (
          <p className="max-w-md rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
            Worst-case de-vigging prices each side independently and on the
            pessimistic side, so the two fair percentages below will not add up
            to 100%. That is the intended behaviour, not a rounding error —
            switch to another method in Settings for a single distribution.
          </p>
        )}
      </div>

      <FeedStatus
        meta={feed.meta}
        loading={feed.loading}
        error={feed.error}
        hint={feed.hint}
        onRefresh={feed.refresh}
        shown={upcoming.length}
      />

      {upcoming.length === 0 ? (
        <div className="rounded-lg border border-[var(--color-line)]">
          <EmptyState title="No upcoming games" body="Select more sports in Settings." />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {upcoming.map((event) => {
            const { rows, books } = buildGrid(event, marketKey, lines);
            if (rows.length === 0) return null;

            return (
              <section
                key={event.id}
                className="overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]"
              >
                <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-line)] px-4 py-2.5">
                  <h2 className="text-sm font-medium">{`${event.awayTeam} @ ${event.homeTeam}`}</h2>
                  <p className="text-[11px] text-[var(--color-faint)]">
                    {event.sportTitle} · {formatClock(event.commenceTime)} (
                    {formatKickoff(event.commenceTime)})
                  </p>
                </header>

                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead className="bg-[var(--color-surface-2)] text-[11px] uppercase tracking-wider text-[var(--color-faint)]">
                      <tr>
                        <th className="sticky left-0 bg-[var(--color-surface-2)] px-3 py-2 text-left font-medium">
                          Selection
                        </th>
                        <th className="px-3 py-2 text-right font-medium">Fair</th>
                        {books.map((book) => (
                          <th
                            key={book}
                            className={`px-3 py-2 text-right font-medium whitespace-nowrap ${
                              bookProfile(book).sharp ? "text-[var(--color-accent)]" : ""
                            }`}
                          >
                            {bookProfile(book).title}
                          </th>
                        ))}
                      </tr>
                    </thead>

                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.key} className="border-t border-[var(--color-line)]">
                          <td className="sticky left-0 bg-[var(--color-surface)] px-3 py-2 text-[13px] font-medium whitespace-nowrap">
                            {row.label}
                          </td>
                          <td className="tnum px-3 py-2 text-right text-[12px] text-[var(--color-muted)]">
                            {row.fairProbability === null ? (
                              "—"
                            ) : (
                              <>
                                <div>
                                  {formatAmericanOdds(
                                    decimalToAmerican(1 / row.fairProbability),
                                  )}
                                </div>
                                <div className="text-[10px] text-[var(--color-faint)]">
                                  {formatPlainPercent(row.fairProbability * 100)}
                                </div>
                              </>
                            )}
                          </td>
                          {books.map((book) => {
                            const cell = row.byBook.get(book);
                            const isBest =
                              cell !== undefined &&
                              cell.decimal >= row.bestDecimal - 1e-9;
                            return (
                              <td
                                key={book}
                                className={`tnum px-3 py-2 text-right text-[13px] ${
                                  isBest
                                    ? "font-semibold text-[var(--color-edge)]"
                                    : "text-[var(--color-text)]"
                                }`}
                              >
                                {cell ? formatAmericanOdds(cell.american) : "—"}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
