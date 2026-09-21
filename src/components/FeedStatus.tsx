"use client";

import { Badge, Button, Spinner } from "./ui";
import { formatAge } from "@/lib/format";

/**
 * The header strip every scanner page shares: where the data came from, how
 * fresh it is, and how to force a refetch.
 *
 * The demo badge is deliberately loud. Showing generated prices without saying
 * so is the one thing a tool like this must never do.
 */
export function FeedStatus({
  meta,
  loading,
  error,
  hint,
  onRefresh,
  autoRefresh,
  onToggleAutoRefresh,
  shown,
}: {
  meta: { demo: boolean; total: number; eventCount: number; updatedAt: string } | null;
  loading: boolean;
  error: string | null;
  hint?: string | null;
  onRefresh: () => void;
  autoRefresh?: boolean;
  onToggleAutoRefresh?: () => void;
  shown: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {meta?.demo && (
        <Badge tone="warn" title="No ODDS_API_KEY is configured, so prices are generated.">
          Demo data
        </Badge>
      )}

      <span className="tnum text-xs text-[var(--color-muted)]">
        {shown}
        {meta && meta.total > shown ? ` of ${meta.total}` : ""} rows
        {meta ? ` · ${meta.eventCount} games` : ""}
      </span>

      {meta && (
        <span className="text-xs text-[var(--color-faint)]">
          updated {formatAge(meta.updatedAt)}
        </span>
      )}

      {loading && <Spinner />}

      <div className="ml-auto flex items-center gap-2">
        {onToggleAutoRefresh && (
          <Button variant="ghost" onClick={onToggleAutoRefresh}>
            {autoRefresh ? "Auto on" : "Auto off"}
          </Button>
        )}
        <Button onClick={onRefresh}>Refresh</Button>
      </div>

      {error && (
        <p className="w-full rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]">
          {error}
          {hint && <span className="block text-[var(--color-muted)]">{hint}</span>}
        </p>
      )}
    </div>
  );
}
