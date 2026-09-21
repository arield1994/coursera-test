"use client";

import { Button, Card, ChipToggle, Field, Input, Select } from "@/components/ui";
import { DEFAULT_SETTINGS, useSettings } from "@/hooks/useSettings";
import { DEVIG_METHODS, DEVIG_METHOD_BLURBS, DEVIG_METHOD_LABELS } from "@/lib/ev/devig";
import { SHARP_BOOKS, SOFT_BOOKS } from "@/lib/odds/books";

export default function SettingsPage() {
  const { settings, update, reset, hydrated } = useSettings();

  if (!hydrated) {
    return <p className="text-sm text-[var(--color-muted)]">Loading settings…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--color-muted)]">
            Saved in this browser and applied to every scanner page.
          </p>
        </div>
        <Button
          variant="danger"
          onClick={() => {
            if (window.confirm("Reset all settings to defaults?")) reset();
          }}
        >
          Reset to defaults
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Bankroll and staking">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Bankroll">
              <Input
                type="number"
                step="50"
                min="0"
                value={settings.bankroll}
                onChange={(e) => update({ bankroll: Number(e.target.value) })}
              />
            </Field>

            <Field
              label="Kelly fraction"
              hint="Full Kelly assumes your fair line is exact. It never is."
            >
              <Select
                value={settings.kellyMultiplier}
                onChange={(e) => update({ kellyMultiplier: Number(e.target.value) })}
              >
                <option value={1}>Full Kelly</option>
                <option value={0.5}>Half Kelly</option>
                <option value={0.25}>Quarter Kelly</option>
                <option value={0.125}>Eighth Kelly</option>
              </Select>
            </Field>

            <Field
              label="Max stake (% of bankroll)"
              hint="Hard cap applied after Kelly, whatever the edge."
            >
              <Input
                type="number"
                step="0.5"
                min="0.1"
                max="100"
                value={settings.maxStakeFraction * 100}
                onChange={(e) =>
                  update({ maxStakeFraction: Number(e.target.value) / 100 })
                }
              />
            </Field>
          </div>
        </Card>

        <Card title="Fair line">
          <div className="flex flex-col gap-3">
            <Field label="De-vig method">
              <Select
                value={settings.devigMethod}
                onChange={(e) =>
                  update({ devigMethod: e.target.value as typeof settings.devigMethod })
                }
              >
                {DEVIG_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {DEVIG_METHOD_LABELS[m]}
                  </option>
                ))}
              </Select>
            </Field>

            <p className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-muted)]">
              {DEVIG_METHOD_BLURBS[settings.devigMethod]}
            </p>

            <Field
              label="Sharp books"
              hint="These define the fair line and are never offered to you as bets."
            >
              <ChipToggle
                options={SHARP_BOOKS.map((b) => ({ value: b.key, label: b.title }))}
                selected={settings.sharpBooks}
                onChange={(sharpBooks) => update({ sharpBooks })}
              />
            </Field>

            <Field
              label="Minimum sharp books"
              hint="Require this many sharp books to agree before trusting a fair line."
            >
              <Select
                value={settings.minSharpBooks}
                onChange={(e) => update({ minSharpBooks: Number(e.target.value) })}
              >
                <option value={1}>1 — most rows, least cross-checking</option>
                <option value={2}>2 — fewer rows, better confirmed</option>
                <option value={3}>3 — strictest</option>
              </Select>
            </Field>
          </div>
        </Card>

        <Card title="Filters">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Min edge %">
              <Input
                type="number"
                step="0.25"
                value={settings.minEvPercent}
                onChange={(e) => update({ minEvPercent: Number(e.target.value) })}
              />
            </Field>

            <Field
              label="Max edge %"
              hint="Anything above this is treated as a stale price and dropped."
            >
              <Input
                type="number"
                step="1"
                value={settings.maxEvPercent}
                onChange={(e) => update({ maxEvPercent: Number(e.target.value) })}
              />
            </Field>

            <Field label="Starts within (hours, 0 = any)">
              <Input
                type="number"
                step="1"
                min="0"
                value={settings.maxHoursAhead}
                onChange={(e) => update({ maxHoursAhead: Number(e.target.value) })}
              />
            </Field>
          </div>

          <div className="mt-3">
            <Field
              label="Your books"
              hint="Leave all off to scan every book. Turn on only the ones you hold accounts at."
            >
              <ChipToggle
                options={SOFT_BOOKS.map((b) => ({ value: b.key, label: b.title }))}
                selected={settings.targetBooks}
                onChange={(targetBooks) => update({ targetBooks })}
              />
            </Field>
          </div>
        </Card>

        <Card title="Refresh">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Auto refresh">
              <Select
                value={settings.autoRefresh ? "on" : "off"}
                onChange={(e) => update({ autoRefresh: e.target.value === "on" })}
              >
                <option value="on">On</option>
                <option value="off">Off</option>
              </Select>
            </Field>

            <Field
              label="Interval (seconds)"
              hint="The server caches upstream responses, so polling faster than the cache TTL costs nothing extra."
            >
              <Input
                type="number"
                min="5"
                step="5"
                value={settings.refreshSeconds}
                onChange={(e) =>
                  update({ refreshSeconds: Math.max(5, Number(e.target.value)) })
                }
              />
            </Field>
          </div>

          <dl className="mt-4 space-y-2 border-t border-[var(--color-line)] pt-3 text-[11px] leading-relaxed text-[var(--color-muted)]">
            <div>
              <dt className="text-[var(--color-text)]">Where the data comes from</dt>
              <dd>
                Set <code className="text-[var(--color-accent)]">ODDS_API_KEY</code> in
                your environment to scan live prices from The Odds API. Without
                it the site runs on a generated demo board and labels every page
                as such.
              </dd>
            </div>
            <div>
              <dt className="text-[var(--color-text)]">Defaults</dt>
              <dd>
                {DEFAULT_SETTINGS.kellyMultiplier * 100}% Kelly,{" "}
                {DEFAULT_SETTINGS.minEvPercent}% minimum edge,{" "}
                {DEVIG_METHOD_LABELS[DEFAULT_SETTINGS.devigMethod].toLowerCase()} de-vig.
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}
