/**
 * In-process TTL cache.
 *
 * Odds providers bill per request and rate-limit hard, while the UI polls. One
 * cache entry per (sport, market) request shape lets many browser refreshes
 * collapse onto a single upstream call.
 *
 * In-flight requests are deduplicated too: without that, ten clients arriving
 * on a cold cache would fire ten identical upstream requests.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = load()
    .then((value) => {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

export function cacheAge(key: string, ttlMs: number): number | null {
  const hit = store.get(key);
  if (!hit) return null;
  return Math.max(0, ttlMs - (hit.expiresAt - Date.now()));
}

export function invalidate(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
