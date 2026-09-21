"use client";

import { useMemo, useState } from "react";
import { FeedStatus } from "@/components/FeedStatus";
import { LegList } from "@/components/LegList";
import { EmptyState, Field, Input, Stat } from "@/components/ui";
import { useFeed } from "@/hooks/useFeed";
import { useSettings } from "@/hooks/useSettings";
import type { MiddleOpportunity } from "@/lib/ev/arbitrage";
import { formatClock, formatKickoff, formatMoney, formatPlainPercent } from "@/lib/format";

export default function MiddlesPage() {
  const { settings, hydrated } = useSettings();
  const [stake, setStake] = useState(500);
  const [maxCost, setMaxCost] = useState(4);
  const [minWidth, setMinWidth] = useState(1);

  const query = useMemo(
    () =>
      new URLSearchParams({
        sports: settings.sports.join(","),
        markets: "spreads,totals",
        stake: String(stake),
        maxCost: String(maxCost),
        minWidth: String(minWidth),
        maxHours: String(settings.maxHoursAhead),
      }).toString(),
    [settings.sports, settings.maxHoursAhead, stake, maxCost, minWidth],
  );

  const feed = useFeed<MiddleOpportunity>("/api/middles", query, {
    enabled: hydrated && settings.autoRefresh,
    intervalMs: settings.refreshSeconds * 1000,
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Middles</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--color-muted)]">
          Two bets on opposite sides at different numbers, arranged so a result
          landing between them wins both. A middle normally costs a little to
          hold — that cost is the price of the lottery ticket — and pays
          several times the stake when the window hits.
        </p>
      </div>

      <div className="grid gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 sm:grid-cols-3">
        <Field label="Total stake">
          <Input
            type="number"
            step="50"
            min="0"
            value={stake}
            onChange={(e) => setStake(Number(e.target.value))}
          />
        </Field>
        <Field label="Max cost to hold %" hint="Negative cost means a free middle.">
          <Input
            type="number"
            step="0.5"
            value={maxCost}
            onChange={(e) => setMaxCost(Number(e.target.value))}
          />
        </Field>
        <Field label="Min window width">
          <Input
            type="number"
            step="0.5"
            min="0.5"
            value={minWidth}
            onChange={(e) => setMinWidth(Number(e.target.value))}
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
        <Stat label="Middles found" value={feed.data.length} />
        <Stat
          label="Cheapest to hold"
          value={
            feed.data.length > 0 ? formatPlainPercent(feed.data[0].costPercent, 2) : "—"
          }
          tone={feed.data[0] && feed.data[0].costPercent <= 0 ? "good" : "neutral"}
        />
        <Stat
          label="Widest window"
          value={
            feed.data.length > 0
              ? Math.max(...feed.data.map((m) => m.windowWidth)).toFixed(1)
              : "—"
          }
          hint="Points of result that win both legs"
        />
      </div>

      {feed.data.length === 0 ? (
        <div className="rounded-lg border border-[var(--color-line)]">
          <EmptyState
            title="No middles inside your cost limit"
            body="Raise the maximum cost to hold, or narrow the minimum window — wide middles are rare and usually expensive."
          />
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {feed.data.map((middle) => (
            <article
              key={middle.id}
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
            >
              <header className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium">{middle.matchup}</h2>
                  <p className="text-[11px] text-[var(--color-faint)]">
                    {middle.sportTitle} · {middle.marketName} ·{" "}
                    {formatClock(middle.commenceTime)} ({formatKickoff(middle.commenceTime)})
                  </p>
                </div>
                <div className="text-right">
                  <div className="tnum text-lg font-semibold text-[var(--color-accent)]">
                    {middle.lowLine} – {middle.highLine}
                  </div>
                  <div className="text-[11px] text-[var(--color-muted)]">middle window</div>
                </div>
              </header>

              <div className="mt-3 border-t border-[var(--color-line)] pt-3">
                <LegList legs={middle.legs} />
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-[var(--color-line)] pt-3 text-[12px]">
                <div>
                  <dt className="text-[var(--color-faint)]">Cost if it misses</dt>
                  <dd
                    className={`tnum font-medium ${
                      middle.costPercent <= 0
                        ? "text-[var(--color-edge)]"
                        : "text-[var(--color-warn)]"
                    }`}
                  >
                    {formatMoney((middle.costPercent / 100) * stake)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--color-faint)]">Return if it hits</dt>
                  <dd className="tnum font-medium text-[var(--color-edge)]">
                    {formatMoney((middle.hitReturnPercent / 100) * stake)}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
