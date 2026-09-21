/**
 * Bundles the console sniffer into one self-contained snippet.
 *
 * It has to survive being pasted into a DevTools console on someone else's
 * site, so: a single IIFE, no imports, no globals beyond `__edgescan`.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "demo/dist");
mkdirSync(out, { recursive: true });

const file = resolve(out, "edgescan-sniffer.js");

await build({
  entryPoints: [resolve(root, "demo/sniffer.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  outfile: file,
  legalComments: "none",
});

const code = readFileSync(file, "utf8");
writeFileSync(
  file,
  `// EdgeScan endpoint finder - paste into DevTools console on your book's site.\n` +
    `// Reads only; __edgescan.stop() restores everything.\n${code}`,
);

console.log(`sniffer built -> ${file} (${(code.length / 1024).toFixed(1)}KB)`);
