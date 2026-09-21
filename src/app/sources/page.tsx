"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, Field, Input, Spinner } from "@/components/ui";
import { SourceStatus, type SourceRow } from "@/components/SourceStatus";
import { applyMapping, type PullSourceConfig } from "@/lib/ingest/pull";
import { validatePayload } from "@/lib/ingest/types";

const EXAMPLE_PAYLOAD = `{
  "book": { "key": "mybookie", "title": "My Bookie", "sharp": false },
  "ttlSeconds": 120,
  "lines": [
    {
      "sport": "basketball_nba",
      "home": "Boston Celtics",
      "away": "LA Lakers",
      "commenceTime": "2030-01-01T00:00:00Z",
      "market": "moneyline",
      "outcomes": [
        { "name": "LA Lakers", "american": 120 },
        { "name": "Boston Celtics", "american": -140 }
      ]
    },
    {
      "home": "Boston Celtics",
      "away": "LA Lakers",
      "market": "totals",
      "outcomes": [
        { "name": "Over", "american": -110, "point": 224.5 },
        { "name": "Under", "american": -110, "point": 224.5 }
      ]
    }
  ]
}`;

const EXAMPLE_RESPONSE = `{
  "data": {
    "events": [
      {
        "fixture": { "home": "Boston Celtics", "away": "LA Lakers", "starts": "2030-01-01T00:00:00Z" },
        "type": "Moneyline",
        "selections": [
          { "label": "LA Lakers", "price_us": "+120" },
          { "label": "Boston Celtics", "price_us": "-140" }
        ]
      }
    ]
  }
}`;

const EXAMPLE_MAPPING: PullSourceConfig = {
  key: "mybookie",
  title: "My Bookie",
  url: "https://api.mybookie.internal/v1/odds",
  headers: { Authorization: "Bearer REPLACE_ME" },
  sharp: false,
  ttlSeconds: 60,
  mapping: {
    lines: "data.events",
    home: "fixture.home",
    away: "fixture.away",
    commenceTime: "fixture.starts",
    market: "type",
    outcomes: "selections",
    outcomeName: "label",
    american: "price_us",
  },
};

type Tab = "status" | "push" | "pull";

export default function SourcesPage() {
  const [tab, setTab] = useState<Tab>("status");
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [meta, setMeta] = useState<{ ingestConfigured: boolean; pullConfigured: number } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/sources");
      const payload = await response.json();
      if (payload.ok) {
        setSources(payload.sources as SourceRow[]);
        setMeta({
          ingestConfigured: payload.ingestConfigured,
          pullConfigured: payload.pullConfigured,
        });
      }
    } catch {
      // Status is a diagnostic view; a failed poll should not blank it.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(load, 10_000);
    return () => window.clearInterval(id);
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Custom sources</h1>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--color-muted)]">
          Add your own prices — a private bookie API, or lines you scrape
          yourself — alongside the main feed. Push them to{" "}
          <code className="text-[var(--color-accent)]">/api/ingest</code>, or
          point EdgeScan at an endpoint and let it pull. Either way they are
          matched onto the same games and treated like any other book.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["status", "push", "pull"] as Tab[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === value
                ? "border-[var(--color-accent)]/60 bg-[var(--color-accent)]/15 text-[var(--color-text)]"
                : "border-[var(--color-line-bright)] bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {value === "status" ? "Live status" : value === "push" ? "Push lines" : "Pull from an API"}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2">
          {loading && <Spinner />}
          <Button onClick={load}>Refresh</Button>
        </div>
      </div>

      {tab === "status" && (
        <>
          <div className="flex flex-wrap gap-2">
            <Badge tone={meta?.ingestConfigured ? "good" : "warn"}>
              {meta?.ingestConfigured ? "INGEST_TOKEN set" : "INGEST_TOKEN not set"}
            </Badge>
            <Badge tone={meta && meta.pullConfigured > 0 ? "good" : "neutral"}>
              {meta?.pullConfigured ?? 0} pull source
              {meta?.pullConfigured === 1 ? "" : "s"} configured
            </Badge>
          </div>
          <SourceStatus sources={sources} />
          <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">
            A source with far more unmatched than matched lines is almost always
            a team-naming mismatch rather than a broken feed. Matching is
            deliberately strict — it drops a line it cannot place rather than
            attaching it to the wrong game, because a price on the wrong game
            produces a confident edge that does not exist.
          </p>
        </>
      )}

      {tab === "push" && <PushTab onPosted={load} tokenRequired={meta?.ingestConfigured} />}
      {tab === "pull" && <PullTab />}
    </div>
  );
}

/** Validate and optionally post a payload, without leaving the browser. */
function PushTab({
  onPosted,
  tokenRequired,
}: {
  onPosted: () => void;
  tokenRequired?: boolean;
}) {
  const [body, setBody] = useState(EXAMPLE_PAYLOAD);
  const [token, setToken] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  // Dry-run the exact server-side validator as you type, so a scraper author
  // can fix the payload before wiring up any HTTP at all.
  const preview = useMemo(() => {
    try {
      const result = validatePayload(JSON.parse(body));
      return {
        ok: true as const,
        accepted: result.lines.length,
        rejected: result.errors.length,
        errors: result.errors,
        book: result.book,
      };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message };
    }
  }, [body]);

  async function post() {
    setPosting(true);
    setResponse(null);
    try {
      const result = await fetch("/api/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
      });
      setResponse(JSON.stringify(await result.json(), null, 2));
      onPosted();
    } catch (error) {
      setResponse(`Request failed: ${(error as Error).message}`);
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Payload">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          spellCheck={false}
          rows={22}
          className="tnum w-full resize-y rounded-md border border-[var(--color-line-bright)] bg-[var(--color-surface-2)] p-3 text-[12px] leading-relaxed text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field
            label="Ingest token"
            hint={
              tokenRequired
                ? "Required: INGEST_TOKEN is set on the server."
                : "Not required while INGEST_TOKEN is unset in development."
            }
          >
            <Input
              type="password"
              value={token}
              placeholder="INGEST_TOKEN"
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button variant="primary" onClick={post} disabled={posting || !preview.ok}>
              {posting ? "Posting…" : "Post to /api/ingest"}
            </Button>
          </div>
        </div>
      </Card>

      <div className="flex flex-col gap-4">
        <Card title="Validation preview">
          {preview.ok ? (
            <div className="flex flex-col gap-2 text-[12px]">
              <div className="flex flex-wrap gap-2">
                <Badge tone="good">{preview.accepted} accepted</Badge>
                {preview.rejected > 0 && <Badge tone="bad">{preview.rejected} rejected</Badge>}
                <Badge tone={preview.book.sharp ? "info" : "neutral"}>
                  {preview.book.key} · {preview.book.sharp ? "sharp" : "soft"}
                </Badge>
              </div>
              {preview.errors.length > 0 && (
                <ul className="mt-1 list-disc space-y-1 pl-5 text-[var(--color-danger)]">
                  {preview.errors.slice(0, 12).map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="text-[12px] text-[var(--color-danger)]">{preview.error}</p>
          )}
        </Card>

        <Card title="From the command line">
          <pre className="overflow-x-auto rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 text-[11px] leading-relaxed text-[var(--color-muted)]">
{`curl -X POST http://localhost:3000/api/ingest \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer $INGEST_TOKEN' \\
  -d @lines.json`}
          </pre>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
            Post on whatever cycle your scraper runs. Each post replaces that
            book&apos;s lines by default; send{" "}
            <code className="text-[var(--color-accent)]">&quot;replace&quot;: false</code> to
            update one sport at a time without clearing the others. Lines expire
            after <code className="text-[var(--color-accent)]">ttlSeconds</code>,
            so a scraper that stops simply disappears from the board instead of
            leaving stale prices up.
          </p>
        </Card>

        {response && (
          <Card title="Response">
            <pre className="max-h-64 overflow-auto rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 text-[11px] leading-relaxed">
              {response}
            </pre>
          </Card>
        )}
      </div>
    </div>
  );
}

/** Build and test a field mapping against a pasted sample response. */
function PullTab() {
  const [sample, setSample] = useState(EXAMPLE_RESPONSE);
  const [config, setConfig] = useState(JSON.stringify(EXAMPLE_MAPPING, null, 2));

  // Everything here runs in the browser: the mapping can be worked out against
  // a pasted sample without the endpoint or its credentials being involved.
  const preview = useMemo(() => {
    let parsedConfig: PullSourceConfig;
    try {
      parsedConfig = JSON.parse(config) as PullSourceConfig;
    } catch (error) {
      return { ok: false as const, error: `Config: ${(error as Error).message}` };
    }
    let parsedSample: unknown;
    try {
      parsedSample = JSON.parse(sample);
    } catch (error) {
      return { ok: false as const, error: `Sample: ${(error as Error).message}` };
    }
    try {
      const result = validatePayload(applyMapping(parsedSample, parsedConfig));
      return {
        ok: true as const,
        accepted: result.lines.length,
        rejected: result.errors.length,
        errors: result.errors,
        lines: result.lines.slice(0, 4),
      };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message };
    }
  }, [sample, config]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Sample response from your API">
        <textarea
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          spellCheck={false}
          rows={14}
          className="tnum w-full resize-y rounded-md border border-[var(--color-line-bright)] bg-[var(--color-surface-2)] p-3 text-[12px] leading-relaxed outline-none focus:border-[var(--color-accent)]"
        />
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
          Paste one real response. Nothing here leaves your browser — the
          mapping is applied and validated client-side, so you can work it out
          without putting credentials anywhere.
        </p>
      </Card>

      <Card title="Source config">
        <textarea
          value={config}
          onChange={(e) => setConfig(e.target.value)}
          spellCheck={false}
          rows={14}
          className="tnum w-full resize-y rounded-md border border-[var(--color-line-bright)] bg-[var(--color-surface-2)] p-3 text-[12px] leading-relaxed outline-none focus:border-[var(--color-accent)]"
        />
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
          Each mapping value is a dotted path into your JSON. Once the preview
          below looks right, put the config in a{" "}
          <code className="text-[var(--color-accent)]">CUSTOM_SOURCES</code>{" "}
          environment variable as a JSON <em>array</em> and restart. EdgeScan
          then polls it for you.
        </p>
      </Card>

      <Card title="Mapping preview" className="lg:col-span-2">
        {preview.ok ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Badge tone={preview.accepted > 0 ? "good" : "bad"}>
                {preview.accepted} line{preview.accepted === 1 ? "" : "s"} parsed
              </Badge>
              {preview.rejected > 0 && <Badge tone="bad">{preview.rejected} rejected</Badge>}
            </div>

            {preview.errors.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-[12px] text-[var(--color-danger)]">
                {preview.errors.slice(0, 12).map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            )}

            {preview.accepted === 0 ? (
              <EmptyState
                title="Nothing parsed out of that sample"
                body="Check the 'lines' path points at the array of games, and that 'outcomes' points at each game's array of prices."
              />
            ) : (
              <pre className="max-h-72 overflow-auto rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 text-[11px] leading-relaxed">
                {JSON.stringify(preview.lines, null, 2)}
              </pre>
            )}
          </div>
        ) : (
          <p className="text-[12px] text-[var(--color-danger)]">{preview.error}</p>
        )}
      </Card>
    </div>
  );
}
