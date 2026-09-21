import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
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
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
