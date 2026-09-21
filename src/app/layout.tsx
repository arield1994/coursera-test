import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "EdgeScan — positive EV betting scanner",
  description:
    "Scan sportsbook odds against a de-vigged sharp consensus line to find positive expected value bets, arbitrage and middles.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="sticky top-0 z-20 border-b border-[var(--color-line)] bg-[var(--color-base)]/95 backdrop-blur">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
            <Link href="/" className="flex items-center gap-2">
              <span className="inline-block h-4 w-1.5 rounded-sm bg-[var(--color-edge)]" />
              <span className="text-sm font-semibold tracking-tight">EdgeScan</span>
            </Link>
            <Nav />
          </div>
        </header>

        <main className="mx-auto max-w-[1600px] px-4 py-5">{children}</main>

        <footer className="mx-auto max-w-[1600px] px-4 pb-10 pt-4">
          <p className="text-[11px] leading-relaxed text-[var(--color-faint)]">
            EdgeScan estimates value from posted prices. A de-vigged line is an
            estimate, not a guarantee, and edges shown here assume you can
            actually get the price on screen. Bet responsibly, and only where it
            is legal for you to do so.
          </p>
        </footer>
      </body>
    </html>
  );
}
