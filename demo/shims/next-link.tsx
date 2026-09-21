/** next/link stand-in: rewrites app paths onto the demo's hash router. */
import type { AnchorHTMLAttributes, ReactNode } from "react";

export default function Link({
  href,
  children,
  ...rest
}: { href: string; children: ReactNode } & Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
>) {
  return (
    <a href={href.startsWith("/") ? `#${href}` : href} {...rest}>
      {children}
    </a>
  );
}
