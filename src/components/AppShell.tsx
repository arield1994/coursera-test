import type { ReactNode } from "react";
import { Nav } from "./Nav";

/**
 * Page chrome shared by the Next.js layout and the standalone demo build, so
 * the two cannot drift apart.
 */
export function AppShell({
  children,
  brandHref = "/",
  notice,
}: {
  children: ReactNode;
  /** The demo build routes on the hash, so it passes "#/" here. */
  brandHref?: string;
  notice?: ReactNode;
}) {
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-[var(--color-line)] bg-[var(--color-base)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <a href={brandHref} className="flex items-center gap-2">
            <span className="inline-block h-4 w-1.5 rounded-sm bg-[var(--color-edge)]" />
            <span className="text-sm font-semibold tracking-tight">EdgeScan</span>
          </a>
          <Nav />
        </div>
      </header>

      {notice}

      <main className="mx-auto max-w-[1600px] px-4 py-5">{children}</main>

      <footer className="mx-auto max-w-[1600px] px-4 pb-10 pt-4">
        <p className="text-[11px] leading-relaxed text-[var(--color-faint)]">
          EdgeScan estimates value from posted prices. A de-vigged line is an
          estimate, not a guarantee, and edges shown here assume you can
          actually get the price on screen. Bet responsibly, and only where it
          is legal for you to do so.
        </p>
      </footer>
    </>
  );
}
