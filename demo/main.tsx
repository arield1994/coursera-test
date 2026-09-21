/**
 * Entry point for the standalone demo build: the real pages and the real
 * engine, wired to a hash router and an in-browser API.
 */
import { StrictMode } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import { usePathname } from "./shims/next-navigation";
import { installApiShim } from "./apiShim";
import { AppShell } from "../src/components/AppShell";

import ScannerPage from "../src/app/page";
import ArbitragePage from "../src/app/arbitrage/page";
import MiddlesPage from "../src/app/middles/page";
import OddsPage from "../src/app/odds/page";
import TrackerPage from "../src/app/tracker/page";
import SourcesPage from "../src/app/sources/page";
import SettingsPage from "../src/app/settings/page";

import "../src/app/globals.css";

installApiShim();

const ROUTES: Record<string, () => React.ReactElement> = {
  "/": ScannerPage,
  "/arbitrage": ArbitragePage,
  "/middles": MiddlesPage,
  "/odds": OddsPage,
  "/tracker": TrackerPage,
  "/sources": SourcesPage,
  "/settings": SettingsPage,
};

function DemoNotice() {
  return (
    <div className="border-b border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10">
      <p className="mx-auto max-w-[1600px] px-4 py-2 text-[11px] leading-relaxed text-[var(--color-warn)]">
        <strong>Live demo.</strong> This is the real scanner running entirely in
        your browser on a generated board — every number is computed by the same
        de-vig and EV code the server runs. Prices are synthetic, not market
        data. Run it against live odds with an API key; see the README.
      </p>
    </div>
  );
}

function App() {
  const pathname = usePathname();
  const Page = ROUTES[pathname] ?? ScannerPage;
  return (
    <AppShell brandHref="#/" notice={<DemoNotice />}>
      <Page />
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
