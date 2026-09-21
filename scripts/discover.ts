/**
 * CLI: point it at a browser network capture and it tells you where your
 * bookmaker's odds API is, and how to read it.
 *
 *   npm run discover -- capture.har
 *
 * Capture one first: open the book's odds page with DevTools on the Network
 * tab, let it load, then "Save all as HAR". Everything the page fetched is in
 * there, including the request that returned the prices.
 */

import { readFileSync } from "node:fs";
import {
  analyzeHar,
  findHtmlCandidates,
  summarizeForSharing,
  toSourceConfig,
} from "../src/lib/ingest/discover";

const args = process.argv.slice(2);
const share = args.includes("--share");
const [file, bookKey = "mybookie"] = args.filter((a) => !a.startsWith("--"));

if (!file) {
  console.error(
    [
      "usage: npm run discover -- <capture.har> [book-key] [--share]",
      "",
      "  --share   print a summary with no secrets in it (no header values,",
      "            no cookies, no query values, structure only) that is safe",
      "            to paste to someone helping you build the mapping.",
    ].join("\n"),
  );
  process.exit(1);
}

let har: unknown;
try {
  har = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`Could not read ${file}: ${(error as Error).message}`);
  process.exit(1);
}

if (share) {
  console.log(JSON.stringify(summarizeForSharing(har), null, 2));
  process.exit(0);
}

const found = analyzeHar(har);
const htmlPages = findHtmlCandidates(har);

if (found.length === 0) {
  if (htmlPages.length > 0) {
    console.log(
      [
        "No JSON API here — this book renders its odds straight into the page.",
        "",
        ...htmlPages.map(
          (page) => `  ${page.url}\n    ~${page.priceCount} prices in ${Math.round(page.bytes / 1024)}KB of HTML`,
        ),
        "",
        "There is nothing to map in that case: CUSTOM_SOURCES needs JSON. Scrape",
        "the page yourself and POST the lines to /api/ingest instead — see",
        "'Push: you send us lines' in the README. The payload format is forgiving,",
        "and the Sources screen validates it as you paste.",
      ].join("\n"),
    );
    process.exit(0);
  }

  console.error(
    [
      "No odds-shaped JSON responses in that capture.",
      "",
      "Things worth checking:",
      "  - Was the Network tab recording before the page loaded? Reload with it open.",
      "  - Did you save *all* requests as HAR, not just the selected one?",
      "  - Some books load odds over a WebSocket, which a HAR does not capture.",
      "    Look for a 'WS' entry in DevTools and read its frames by hand.",
      "  - Odds may arrive only after you pick a sport or a league; click through",
      "    to the page that actually shows prices, then save.",
    ].join("\n"),
  );
  process.exit(2);
}

console.log(`Found ${found.length} candidate endpoint${found.length === 1 ? "" : "s"}:\n`);

found.forEach((source, index) => {
  const pct = Math.round(source.confidence * 100);
  console.log(`${index + 1}. [${pct}% confidence] ${source.method} ${source.url}`);
  console.log(`   ${source.gameCount} games, ${source.outcomeCount} outcomes in the first game`);
  if (source.authHeaders.length > 0) {
    console.log(`   likely required headers: ${source.authHeaders.join(", ")}`);
  }
  for (const note of source.notes) console.log(`   note: ${note}`);
  console.log();
});

const best = found[0];

console.log("Best guess, as a CUSTOM_SOURCES entry:\n");
console.log(`CUSTOM_SOURCES='${JSON.stringify([toSourceConfig(best, bookKey)])}'`);
if (htmlPages.length > 0) {
  console.log(
    `Also saw ${htmlPages.length} server-rendered page(s) with prices in the HTML; ` +
      "the JSON endpoint above is the better target.\n",
  );
}

console.log(
  [
    "",
    "Next steps:",
    "  1. Fill in the REPLACE_WITH_YOUR_* header values from your own session.",
    "  2. Paste a real response into Sources -> Pull from an API and check the",
    "     mapping preview parses it the way you expect.",
    "  3. Put the line above in .env and restart.",
    "",
    "Header values were deliberately not copied out of the capture: a HAR holds",
    "live session tokens, so it should be treated like a password file and not",
    "committed or shared.",
  ].join("\n"),
);
