/**
 * Minimal stand-in for next/navigation in the standalone demo build.
 *
 * The demo is a single static page, so routing runs off the URL hash. Pages
 * import usePathname unchanged and get "/arbitrage" out of "#/arbitrage".
 */
import { useSyncExternalStore } from "react";

function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash || "/";
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, currentPath, () => "/");
}

export function useRouter() {
  return {
    push: (href: string) => {
      window.location.hash = href;
    },
    replace: (href: string) => {
      window.location.replace(`#${href}`);
    },
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh: () => {},
    prefetch: () => {},
  };
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}
