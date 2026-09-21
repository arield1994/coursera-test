"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface FeedState<T> {
  data: T[];
  meta: { demo: boolean; total: number; eventCount: number; updatedAt: string } | null;
  loading: boolean;
  error: string | null;
  hint: string | null;
  refresh: () => void;
}

interface ApiSuccess<T> {
  ok: true;
  data: T[];
  demo: boolean;
  total: number;
  eventCount: number;
  updatedAt: string;
}

interface ApiFailure {
  ok: false;
  error: string;
  hint?: string;
}

/**
 * Polls one of the scan endpoints.
 *
 * Two things matter here. In-flight requests are aborted when the query changes
 * or the component unmounts, so a slow response for old filters can't land
 * after a fast one for new filters and overwrite it. And a failed refresh keeps
 * the previous rows on screen rather than blanking the table — a transient
 * upstream error shouldn't erase a board you were reading.
 */
export function useFeed<T>(
  endpoint: string,
  query: string,
  { enabled = true, intervalMs = 0 }: { enabled?: boolean; intervalMs?: number } = {},
): FeedState<T> {
  const [data, setData] = useState<T[]>([]);
  const [meta, setMeta] = useState<FeedState<T>["meta"]>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    try {
      const response = await fetch(`${endpoint}?${query}`, { signal: controller.signal });
      const payload = (await response.json()) as ApiSuccess<T> | ApiFailure;

      if (controller.signal.aborted) return;

      if (!payload.ok) {
        setError(payload.error);
        setHint(payload.hint ?? null);
        return;
      }

      setData(payload.data);
      setMeta({
        demo: payload.demo,
        total: payload.total ?? payload.data.length,
        eventCount: payload.eventCount ?? 0,
        updatedAt: payload.updatedAt,
      });
      setError(null);
      setHint(null);
    } catch (cause) {
      if ((cause as Error).name === "AbortError") return;
      setError((cause as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [endpoint, query]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load, nonce]);

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    const id = window.setInterval(() => setNonce((n) => n + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { data, meta, loading, error, hint, refresh };
}
