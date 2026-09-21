"use client";

import { useEffect, useState } from "react";
import { Button, ChipToggle, Field, Input, Select } from "./ui";
import { DEVIG_METHODS, DEVIG_METHOD_BLURBS, DEVIG_METHOD_LABELS } from "@/lib/ev/devig";
import { SHARP_BOOKS, SOFT_BOOKS } from "@/lib/odds/books";
import { marketLabel } from "@/lib/odds/types";
import type { Settings } from "@/hooks/useSettings";
import type { Sport } from "@/lib/odds/types";

const MARKETS = ["h2h", "spreads", "totals"];

export function ScannerFilters({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  const [sports, setSports] = useState<Sport[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sports")
      .then((r) => r.json())
      .then((payload) => {
        if (!cancelled && payload.ok) setSports(payload.data as Sport[]);
      })
      .catch(() => {
        // The sports list is a convenience; the board still loads without it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Min edge">
          <Input
            type="number"
            step="0.25"
            value={settings.minEvPercent}
            onChange={(e) => update({ minEvPercent: Number(e.target.value) })}
          />
        </Field>

        <Field label="De-vig method">
          <Select
            value={settings.devigMethod}
            onChange={(e) => update({ devigMethod: e.target.value as Settings["devigMethod"] })}
          >
            {DEVIG_METHODS.map((m) => (
              <option key={m} value={m}>
                {DEVIG_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Bankroll">
          <Input
            type="number"
            step="50"
            min="0"
            value={settings.bankroll}
            onChange={(e) => update({ bankroll: Number(e.target.value) })}
          />
        </Field>

        <Field label="Kelly fraction">
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

        <Field label="Starts within">
          <Select
            value={settings.maxHoursAhead}
            onChange={(e) => update({ maxHoursAhead: Number(e.target.value) })}
          >
            <option value={0}>Any time</option>
            <option value={3}>3 hours</option>
            <option value={12}>12 hours</option>
            <option value={24}>24 hours</option>
            <option value={72}>3 days</option>
          </Select>
        </Field>
      </div>

      <div className="border-t border-[var(--color-line)] px-3 py-2">
        <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"} sports, books &amp; markets
        </Button>
      </div>

      {open && (
        <div className="grid gap-4 border-t border-[var(--color-line)] p-3 lg:grid-cols-2">
          <Field label="Sports">
            <ChipToggle
              options={sports.map((s) => ({ value: s.key, label: s.title }))}
              selected={settings.sports}
              onChange={(sports) => update({ sports })}
            />
          </Field>

          <Field label="Markets">
            <ChipToggle
              options={MARKETS.map((m) => ({ value: m, label: marketLabel(m) }))}
              selected={settings.markets}
              onChange={(markets) => update({ markets })}
            />
          </Field>

          <Field
            label="Sharp books (build the fair line)"
            hint="These books define what a price should be. They are never offered as bets."
          >
            <ChipToggle
              options={SHARP_BOOKS.map((b) => ({ value: b.key, label: b.title }))}
              selected={settings.sharpBooks}
              onChange={(sharpBooks) => update({ sharpBooks })}
            />
          </Field>

          <Field
            label="Your books (where you bet)"
            hint="Leave all off to scan every book you could bet at."
          >
            <ChipToggle
              options={SOFT_BOOKS.map((b) => ({ value: b.key, label: b.title }))}
              selected={settings.targetBooks}
              onChange={(targetBooks) => update({ targetBooks })}
            />
          </Field>

          <p className="text-[11px] leading-relaxed text-[var(--color-muted)] lg:col-span-2">
            <span className="text-[var(--color-text)]">
              {DEVIG_METHOD_LABELS[settings.devigMethod]}:
            </span>{" "}
            {DEVIG_METHOD_BLURBS[settings.devigMethod]}
          </p>
        </div>
      )}
    </div>
  );
}
