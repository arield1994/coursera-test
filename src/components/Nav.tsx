"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "+EV Scanner" },
  { href: "/arbitrage", label: "Arbitrage" },
  { href: "/middles", label: "Middles" },
  { href: "/odds", label: "Odds Screen" },
  { href: "/tracker", label: "Bet Tracker" },
  { href: "/sources", label: "Sources" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-0.5 overflow-x-auto">
      {LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
              active
                ? "bg-[var(--color-surface-2)] text-[var(--color-text)]"
                : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
