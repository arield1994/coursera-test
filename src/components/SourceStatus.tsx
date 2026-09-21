"use client";

import { Badge, EmptyState } from "./ui";
import { formatAge } from "@/lib/format";

export interface SourceRow {
  key: string;
  title: string;
  sharp: boolean;
  sharpWeight: number;
  lines: number;
  receivedAt: string;
  expiresAt: string;
  ttlSeconds: number;
  origin: "pull" | "push";
  matched: number | null;
  unmatched: number | null;
  createMissingEvents: boolean;
}

/**
 * Live status of every custom source.
 *
 * The matched/unmatched split is the column that matters: a source posting
 * hundreds of lines that all fail to match a game is indistinguishable from a
 * working one until you look here.
 */
export function SourceStatus({ sources }: { sources: SourceRow[] }) {
  if (sources.length === 0) {
    return (
      <EmptyState
        title="No custom sources are live"
        body="Push lines to /api/ingest, or configure a private API to pull from. Anything you send appears here within one refresh and expires on its own TTL."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--color-line)]">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <thead className="bg-[var(--color-surface-2)] text-[11px] uppercase tracking-wider text-[var(--color-faint)]">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Source</th>
            <th className="px-3 py-2 text-left font-medium">Role</th>
            <th className="px-3 py-2 text-right font-medium">Lines</th>
            <th className="px-3 py-2 text-right font-medium">Matched</th>
            <th className="px-3 py-2 text-right font-medium">Unmatched</th>
            <th className="px-3 py-2 text-left font-medium">Received</th>
            <th className="px-3 py-2 text-left font-medium">Expires</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => {
            const unmatched = source.unmatched ?? 0;
            const matched = source.matched ?? 0;
            const mostlyFailing = matched + unmatched > 0 && unmatched > matched;

            return (
              <tr key={source.key} className="border-t border-[var(--color-line)]">
                <td className="px-3 py-2">
                  <div className="text-[13px] font-medium">{source.title}</div>
                  <div className="text-[11px] text-[var(--color-faint)]">
                    {source.key} · {source.origin}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {source.sharp ? (
                    <Badge tone="info" title="Helps define the fair line.">
                      sharp {source.sharpWeight.toFixed(2)}
                    </Badge>
                  ) : (
                    <Badge title="Scanned for value; never used to price the market.">
                      soft
                    </Badge>
                  )}
                </td>
                <td className="tnum px-3 py-2 text-right">{source.lines}</td>
                <td className="tnum px-3 py-2 text-right text-[var(--color-edge)]">
                  {source.matched ?? "—"}
                </td>
                <td
                  className={`tnum px-3 py-2 text-right ${
                    mostlyFailing ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"
                  }`}
                >
                  {source.unmatched ?? "—"}
                </td>
                <td className="px-3 py-2 text-[12px] text-[var(--color-muted)]">
                  {formatAge(source.receivedAt)}
                </td>
                <td className="px-3 py-2 text-[12px] text-[var(--color-muted)]">
                  in {Math.max(0, Math.round((Date.parse(source.expiresAt) - Date.now()) / 1000))}s
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
