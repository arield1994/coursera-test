export function formatAmericanOdds(american: number): string {
  if (!Number.isFinite(american)) return "—";
  const rounded = Math.round(american);
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export function formatPlainPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function formatMoney(value: number, currency = "$"): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  return `${sign}${currency}${Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** "in 3h 20m" / "in 2d" — bettors care about time to post, not the clock. */
export function formatKickoff(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const minutes = Math.round((time - Date.now()) / 60_000);
  if (minutes < 0) return "live";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1d" : `${days}d`;
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "12s ago" — how stale the price on screen is. */
export function formatAge(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
