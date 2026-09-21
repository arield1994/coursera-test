/**
 * Bundles the real app into a single static page.
 *
 * next/link and next/navigation are aliased to local shims, and fetch is
 * intercepted at runtime; nothing else about the pages changes.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "demo/dist");
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve(root, "demo/main.tsx")],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  outfile: resolve(out, "app.js"),
  banner: {
    // Shared modules read config off process.env at import time (cache TTLs,
    // API keys). In the browser there is no process, and every such value
    // should fall back to its default anyway.
    js: "globalThis.process=globalThis.process||{env:{}};",
  },
  logOverride: { "unsupported-jsx-comment": "silent" },
  alias: {
    "next/link": resolve(root, "demo/shims/next-link.tsx"),
    "next/navigation": resolve(root, "demo/shims/next-navigation.ts"),
    "@": resolve(root, "src"),
  },
  loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"' },
});

execFileSync(
  "npx",
  [
    "@tailwindcss/cli",
    "-i",
    resolve(root, "src/app/globals.css"),
    "-o",
    resolve(out, "app.css"),
    "--minify",
  ],
  { cwd: root, stdio: "inherit" },
);

writeFileSync(
  resolve(out, "index.html"),
  readFileSync(resolve(root, "demo/index.html"), "utf8"),
);

// The Artifact host supplies its own <!doctype>/<html>/<head>/<body>, so the
// published page is a fragment: title, stylesheet link, mount point, script.
writeFileSync(
  resolve(out, "artifact.html"),
  [
    "<title>EdgeScan</title>",
    '<link rel="stylesheet" href="app.css" />',
    '<div id="root"></div>',
    '<script type="module" src="app.js"></script>',
    "",
  ].join("\n"),
);

console.log("demo built ->", out);
