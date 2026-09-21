"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * State mirrored into localStorage.
 *
 * Reads are deferred to an effect rather than done during the initial render:
 * the server has no localStorage, so reading it inline would make the first
 * client render disagree with the server's HTML and React would discard it.
 * The cost is one extra render on mount, which is the right trade.
 *
 * Every access is guarded — Safari private mode throws on access rather than
 * returning null, and a corrupted value should not take the page down.
 */
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored !== null) setValue(JSON.parse(stored) as T);
    } catch {
      // Unreadable or unparseable — keep the default.
    }
    setHydrated(true);
  }, [key]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota exceeded or storage blocked; the app stays usable in memory.
    }
  }, [key, value, hydrated]);

  const reset = useCallback(() => setValue(initial), [initial]);

  return { value, setValue, hydrated, reset } as const;
}
