"use client";

import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes } from "react";

export function Card({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] ${className}`}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-wide text-[var(--color-text)]">
            {title}
          </h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "good" | "bad" | "warn";
}) {
  const toneClass = {
    neutral: "text-[var(--color-text)]",
    good: "text-[var(--color-edge)]",
    bad: "text-[var(--color-danger)]",
    warn: "text-[var(--color-warn)]",
  }[tone];

  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-faint)]">
        {label}
      </div>
      <div className={`tnum mt-1 text-xl font-semibold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-[var(--color-muted)]">{hint}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "bad" | "warn" | "info";
  title?: string;
}) {
  const tones = {
    neutral: "border-[var(--color-line-bright)] text-[var(--color-muted)]",
    good: "border-[var(--color-edge)]/40 text-[var(--color-edge)] bg-[var(--color-edge)]/10",
    bad: "border-[var(--color-danger)]/40 text-[var(--color-danger)] bg-[var(--color-danger)]/10",
    warn: "border-[var(--color-warn)]/40 text-[var(--color-warn)] bg-[var(--color-warn)]/10",
    info: "border-[var(--color-accent)]/40 text-[var(--color-accent)] bg-[var(--color-accent)]/10",
  }[tone];

  return (
    <span
      title={title}
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tones}`}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wider text-[var(--color-faint)]">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-[var(--color-muted)]">{hint}</span>}
    </label>
  );
}

const CONTROL =
  "w-full rounded-md border border-[var(--color-line-bright)] bg-[var(--color-surface-2)] px-2.5 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]";

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", ...rest } = props;
  return <select {...rest} className={`${CONTROL} ${className}`} />;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return <input {...rest} className={`${CONTROL} tnum ${className}`} />;
}

/**
 * A checkbox list rendered as toggle chips.
 *
 * An empty selection means "no filter" everywhere in this app, which is why the
 * caller labels it rather than this component guessing.
 */
export function ChipToggle({
  options,
  selected,
  onChange,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const active = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() =>
              onChange(
                active
                  ? selected.filter((v) => v !== option.value)
                  : [...selected, option.value],
              )
            }
            className={`rounded-md border px-2 py-1 text-xs transition-colors ${
              active
                ? "border-[var(--color-accent)]/60 bg-[var(--color-accent)]/15 text-[var(--color-text)]"
                : "border-[var(--color-line-bright)] bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:border-[var(--color-line-bright)] hover:text-[var(--color-text)]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  type = "button",
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
}) {
  const variants = {
    default:
      "border-[var(--color-line-bright)] bg-[var(--color-surface-2)] text-[var(--color-text)] hover:border-[#3a4859]",
    primary:
      "border-[var(--color-edge)]/50 bg-[var(--color-edge)]/15 text-[var(--color-edge)] hover:bg-[var(--color-edge)]/25",
    ghost: "border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]",
    danger:
      "border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/20",
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${variants}`}
    >
      {children}
    </button>
  );
}

export function EmptyState({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="text-sm font-medium text-[var(--color-text)]">{title}</p>
      <p className="max-w-md text-xs leading-relaxed text-[var(--color-muted)]">{body}</p>
    </div>
  );
}

export function Spinner() {
  return (
    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-line-bright)] border-t-[var(--color-accent)]" />
  );
}
