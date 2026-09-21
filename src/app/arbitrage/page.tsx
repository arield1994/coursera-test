"use client";

import { useMemo, useState } from "react";
import { FeedStatus } from "@/components/FeedStatus";
import { LegList } from "@/components/LegList";
import { EmptyState, Field, Input, Stat } from "@/components/ui";
import { useFeed } from "@/hooks/useFeed";
import { useSettings } from "@/hooks/useSettings";
import type { ArbOpportunity } from "@/lib/ev/arbitrage";
import { formatClock, formatKickoff, formatMoney, formatPlainPercent } from "@/lib/format";

export default function ArbitragePage() {
  const { settings, hydrated } = useSettings();
  const [stake, setStake] = useState(500);
  const [minProfit, setMinProfit] = useState(0.25);

  const query = useMemo(
    () =>
      new URLSearchParams({
        sports: settings.sports.join(","),
        markets: settings.markets.join(","),
        stake: String(stake),
        minProfit: String(minProfit),
        maxHours: String(settings.maxHoursAhead),
      }).toString(),
    [settings.sports, settings.markets, settings.maxHoursAhead, stake, minProfit],
  );

  const feed = useFeed<ArbOpportunity>("/api/arbitrage", query, {
    enabled: hydrated && settings.autoRefresh,
    intervalMs: settings.refreshSeconds * 1000,
  });

  const totalProfit = feed.data.reduce((s, a) => s + a.guaranteedProfit, 0);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Arbitrage</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--color-muted)]">
          Two books disagreeing enough that backing every side locks a profit.
          This is the one screen here that needs no probability model at all —
          if the implied probabilities sum to under 100%, the return is fixed
          before the game starts. Books limit accounts for this, and prices move
          fast, so treat large numbers as stale rather than free.
        </p>
      </div>

      <div className="grid gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Total stake per arb">
          <Input
            type="number"
            step="50"
            min="0"
            value={stake}
            onChange={(e) => setStake(Number(e.target.value))}
          />
        </Field>
        <Field label="Min profit %">
          <Input
            type="number"
            step="0.25"
            value={minProfit}
            onChange={(e) => setMinProfit(Number(e.target.value))}
          />
        </Field>
      </div>

      <FeedStatus
        meta={feed.meta}
        loading={feed.loading}
        error={feed.error}
        hint={feed.hint}
        onRefresh={feed.refresh}
        shown={feed.data.length}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Opportunities" value={feed.data.length} />
        <Stat
          label="Best return"
          value={formatPlainPercent(feed.data[0]?.profitPercent ?? 0, 2)}
          tone={feed.data.length > 0 ? "good" : "neutral"}
        />
        <Stat
          label="Combined locked profit"
          value={formatMoney(totalProfit)}
          hint={`If every arb is taken at ${formatMoney(stake)}`}
        />
      </div>

      {feed.data.length === 0 ? (
        <div className="rounded-lg border border-[var(--color-line)]">
          <EmptyState
            title="No arbitrage on the board"
            body="This is the expected result almost all of the time. Real arbs appear for seconds at a time, usually on markets the books have not yet moved together."
          />
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {feed.data.map((arb) => (
            <article
              key={arb.id}
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
            >
              <header className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium">{arb.matchup}</h2>
                  <p className="text-[11px] text-[var(--color-faint)]">
                    {arb.sportTitle} · {arb.marketName} · {formatClock(arb.commenceTime)} (
                    {formatKickoff(arb.commenceTime)})
                  </p>
                </div>
                <div className="text-right">
                  <div className="tnum text-lg font-semibold text-[var(--color-edge)]">
                    {formatPlainPercent(arb.profitPercent, 2)}
                  </div>
                  <div className="tnum text-[11px] text-[var(--color-muted)]">
                    {formatMoney(arb.guaranteedProfit)} locked
                  </div>
                </div>
              </header>

              <div className="mt-3 border-t border-[var(--color-line)] pt-3">
                <LegList legs={arb.legs} />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
