"use client";

import { useMemo } from "react";
import { EvTable } from "@/components/EvTable";
import { FeedStatus } from "@/components/FeedStatus";
import { ScannerFilters } from "@/components/ScannerFilters";
import { Stat } from "@/components/ui";
import { useBets } from "@/hooks/useBets";
import { useFeed } from "@/hooks/useFeed";
import { scanQuery, useSettings } from "@/hooks/useSettings";
import type { EvOpportunity } from "@/lib/ev/scanner";
import { formatMoney, formatPercent } from "@/lib/format";

export default function ScannerPage() {
  const { settings, update, hydrated } = useSettings();
  const query = useMemo(() => scanQuery(settings), [settings]);
  const { addBet } = useBets();

  const feed = useFeed<EvOpportunity>("/api/scan", query, {
    // Don't fire a request against default settings before the saved ones load.
    enabled: hydrated && settings.autoRefresh,
    intervalMs: settings.refreshSeconds * 1000,
  });

  const summary = useMemo(() => {
    if (feed.data.length === 0) {
      return { best: 0, median: 0, totalStake: 0, expected: 0 };
    }
    const edges = feed.data.map((o) => o.evPercent).sort((a, b) => a - b);
    const totalStake = feed.data.reduce((s, o) => s + o.stake, 0);
    return {
      best: edges[edges.length - 1],
      median: edges[Math.floor(edges.length / 2)],
      totalStake,
      // What the model expects this whole slate to return, if every edge is real.
      expected: feed.data.reduce((s, o) => s + (o.stake * o.evPercent) / 100, 0),
    };
  }, [feed.data]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Positive EV scanner</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--color-muted)]">
          Every sharp book&apos;s market is de-vigged to a fair probability, blended
          into one consensus line, and compared against what your books are
          offering on the same side at the same number. Rows are the bets where
          the offered price pays more than fair.
        </p>
      </div>

      <ScannerFilters settings={settings} update={update} />

      <FeedStatus
        meta={feed.meta}
        loading={feed.loading}
        error={feed.error}
        hint={feed.hint}
        onRefresh={feed.refresh}
        autoRefresh={settings.autoRefresh}
        onToggleAutoRefresh={() => update({ autoRefresh: !settings.autoRefresh })}
        shown={feed.data.length}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Best edge"
          value={formatPercent(summary.best)}
          tone={summary.best > 0 ? "good" : "neutral"}
        />
        <Stat label="Median edge" value={formatPercent(summary.median)} />
        <Stat
          label="Total suggested stake"
          value={formatMoney(summary.totalStake)}
          hint={`${(settings.kellyMultiplier * 100).toFixed(0)}% Kelly on ${formatMoney(settings.bankroll)}`}
        />
        <Stat
          label="Expected return"
          value={formatMoney(summary.expected)}
          tone={summary.expected > 0 ? "good" : "neutral"}
          hint="If every edge shown is real"
        />
      </div>

      <EvTable
        rows={feed.data}
        onLogBet={(row) =>
          addBet({
            sportTitle: row.sportTitle,
            matchup: row.matchup,
            marketName: row.marketName,
            selection: row.selection,
            book: row.book,
            bookTitle: row.bookTitle,
            decimal: row.decimal,
            stake: row.stake,
            evPercentAtBet: row.evPercent,
            fairProbabilityAtBet: row.fairProbability,
            commenceTime: row.commenceTime,
          })
        }
      />
    </div>
  );
}
