# EdgeScan

A positive-EV sports betting scanner, in the vein of OddsJam: it de-vigs sharp
bookmakers' prices into a fair line, compares every other book against it, and
surfaces the bets where the offered price pays more than fair. It also finds
arbitrage, middles, and does line shopping across books.

Runs with no configuration on a generated demo board, and against live prices
once you supply an odds API key.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

No API key is needed to look around — the app falls back to a deterministic
demo feed and labels every page **Demo data** so generated prices are never
mistaken for live ones.

For live odds, get a key from [the-odds-api.com](https://the-odds-api.com):

```bash
cp .env.example .env
# set ODDS_API_KEY=...
```

```bash
npm test             # 98 tests over the odds/EV/arbitrage/ingest engine
npm run demo         # build the standalone browser demo and serve it
npm run typecheck
npm run build
```

## What it does

| Screen | What it answers |
| --- | --- |
| **+EV Scanner** | Which offered prices beat the sharp consensus fair line, and how much to stake |
| **Arbitrage** | Which markets can be backed on every side for a locked profit |
| **Middles** | Which pairs of opposing lines leave a window that wins both bets |
| **Odds Screen** | Every book's price side by side, with the fair line and the best price |
| **Bet Tracker** | Logged bets, P/L, ROI, and closing line value |
| **Sources** | Add your own prices — a private bookie API, or lines you scrape |

## Adding your own lines

A private bookie API or your own scraped lines can sit alongside the main feed
and be treated like any other book — scanned for value, used for arbitrage,
and (if you choose) trusted to help define the fair line. There are two ways in,
and both converge on the same validation and the same store.

The **Sources** screen is the control panel for all of it: live status per
source, a payload validator, and a mapping builder that previews against a
pasted sample response without any credentials leaving your browser.

### Push: you send us lines

Post from whatever your scraper already runs on:

```bash
curl -X POST http://localhost:3000/api/ingest \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -d '{
    "book": { "key": "mybookie", "title": "My Bookie", "sharp": false },
    "ttlSeconds": 120,
    "lines": [{
      "sport": "basketball_nba",
      "home": "Boston Celtics",
      "away": "LA Lakers",
      "commenceTime": "2030-01-01T00:00:00Z",
      "market": "moneyline",
      "outcomes": [
        { "name": "LA Lakers", "american": 120 },
        { "name": "Boston Celtics", "american": -140 }
      ]
    }]
  }'
```

The format is forgiving where it can afford to be and strict where it cannot.
`american` or `decimal`, either is fine. `moneyline`, `ML`, `1X2`, `Over/Under`,
`Run Line` and friends all map to the right internal market. Team names do not
need to match the feed's spelling.

What it will *not* accept is a price of zero, an American price between -100 and
+100 (almost always a mislabelled decimal), or a market with one side. Bad lines
are dropped individually and the response says exactly which and why, so one
malformed game never discards a scrape of two hundred good ones:

```json
{ "ok": true, "accepted": 2, "rejected": 1,
  "errors": ["line 2: needs at least 2 outcomes (got 1)"] }
```

Each post replaces that book's lines by default; send `"replace": false` to
update one sport at a time. Lines expire after `ttlSeconds` (default 120), so a
scraper that dies disappears from the board instead of leaving stale prices up.

### Finding your book's endpoint

If you don't already know your book's API, you don't have to guess. Almost every
sportsbook site is a JavaScript front end talking to its own JSON API, and the
browser will show you exactly where:

1. Open the book's odds page with DevTools on the **Network** tab, filtered to
   **Fetch/XHR**, and reload so the tab is recording from the start.
2. Click through to a page that actually shows prices.
3. Right-click the request list and **Save all as HAR**.

Then let EdgeScan read it:

```bash
npm run discover -- capture.har mybookie
```

It scores every JSON response for how much it looks like odds, ignores the
tracking and asset noise, and prints a ready-to-paste `CUSTOM_SOURCES` entry
with the mapping already worked out — which field holds the teams, where the
markets and outcomes are nested, whether prices are American or decimal, and
which request headers you'll need to supply:

```
1. [96% confidence] GET https://api.example/v3/offering/events?sport=basketball
   2 games, 2 outcomes in the first game
   likely required headers: Authorization, X-Api-Key
```

Header *values* are deliberately not copied out of the capture. **A HAR contains
live session tokens — treat it like a password file, and don't commit or share
it.** The generated config has `REPLACE_WITH_YOUR_*` placeholders to fill in
yourself. `.har` is gitignored for this reason.

If you want someone else's help building the mapping, don't send them the HAR.
Send them this instead:

```bash
npm run discover -- capture.har mybookie --share
```

That prints the endpoint with query *values* stripped, the header *names* only,
and the response's **shape** — keys and types, no values at all. Enough to work
out a mapping, with no tokens, cookies, account identifiers or balances in it.

**If your book has no JSON API**, the tool says so and points at the pages that
render odds directly into HTML. Some smaller books and agent portals work that
way. There is nothing to map then — `CUSTOM_SOURCES` needs JSON — so scrape the
page yourself and POST to `/api/ingest` instead, which is what the push route
is for.

Check the result in **Sources → Pull from an API** before trusting it: paste a
real response and confirm the mapping preview parses it the way you expect.

A few things the capture may not show you. Some books stream odds over a
**WebSocket** rather than HTTP, which a HAR won't record — look for a `WS` entry
in DevTools and read its frames by hand. Endpoints are often **geo-fenced** and
tied to a session, so the headers matter as much as the URL. And these are
private APIs: they can change without notice, they usually sit behind terms that
restrict automated access, and hammering one is the fastest way to get an
account limited. Poll at a sane interval — `ttlSeconds` of 60 with
`CUSTOM_SOURCE_TTL_MS` at 20s is already gentler than most people manage.

If your book publishes an **official** API or data feed, prefer it: it's stable,
it's permitted, and it usually returns cleaner data than the site's internal one.

### Pull: we fetch from your API

Set `CUSTOM_SOURCES` to a JSON array of endpoints and EdgeScan polls them for
you. Your API does not have to speak our schema — a field mapping of dotted
paths translates whatever it returns:

```json
[{
  "key": "mybookie",
  "url": "https://api.mybookie.internal/v1/odds",
  "headers": { "Authorization": "Bearer ..." },
  "sharp": false,
  "ttlSeconds": 60,
  "mapping": {
    "lines": "data.events",
    "home": "fixture.home", "away": "fixture.away",
    "commenceTime": "fixture.starts", "market": "type",
    "outcomes": "selections", "outcomeName": "label", "american": "price_us"
  }
}]
```

When a game carries several markets together — the usual shape — point
`markets` at that array and `market` / `outcomes` resolve against each one, so
the moneyline, spread and total all come through as separate lines instead of
only the first:

```json
"mapping": {
  "lines": "events",
  "home": "home_team", "away": "away_team", "commenceTime": "start_time",
  "markets": "markets", "market": "market_type",
  "outcomes": "outcomes", "outcomeName": "name",
  "american": "price", "point": "line"
}
```

### Sharp or soft

A new source defaults to **soft**: scanned for value, never used to price a
market. Set `"sharp": true` with a `sharpWeight` to let it contribute to the
consensus fair line — worth doing for a genuine sharp feed, and worth *not*
doing until you have reason to trust it. A custom source can never claim a
built-in key: a scraper registering itself as `pinnacle` is ignored in favour of
the real profile, so it cannot promote itself into the fair line.

### Matching, and why lines get dropped

Your "LA Lakers" has to land on the feed's "Los Angeles Lakers", or the price
sits in a market of one with nothing to compare it against. Names are normalized
(accents, punctuation, `L.A.` → `la`, club suffixes, common abbreviations) and
scored; the matched event's spelling is then written back onto the outcomes so
they group with everyone else's.

Matching is deliberately conservative, because a price attached to the *wrong*
game produces a confident edge that does not exist. A candidate must clear a
similarity threshold **and** beat the runner-up by a margin, so an ambiguous
"United" against both Manchester and Newcastle United is dropped rather than
guessed. Same-city neighbours (Lakers/Clippers, Yankees/Mets) score well below
the threshold.

Dropped lines are counted per source and shown on the Sources screen. **A source
with far more unmatched than matched lines is almost always a team-naming
mismatch, not a broken feed** — that column is the first place to look. If your
book carries games the main feed does not, set `"createMissingEvents": true` and
they are kept as events of their own.

## How the edge is calculated

A posted market always sums to more than 100% implied probability; the excess
is the book's margin. Finding value means stripping that margin off a book that
prices accurately, then checking whether anyone else is paying more than the
result.

1. **Group by market _and line._** A +3.5 at one book is only ever compared to a
   +3.5 at another. Comparing across lines is the classic way to manufacture an
   edge that isn't there.
2. **De-vig each sharp book independently.** Five methods are supported —
   multiplicative, additive, power, Shin, and a conservative worst case. They
   disagree most on longshots, which is exactly where naive scanners go wrong.
3. **Blend into a consensus.** Each sharp book is de-vigged first and then
   weighted; averaging *posted* prices would blend the books' margins into the
   estimate.
4. **Price every other book against it.** `EV = p × decimal − 1`, with a
   fractional-Kelly stake of `edge / (decimal − 1)` scaled by your multiplier
   and capped.

Markets with no sharp reference are skipped rather than de-vigged against the
field — otherwise the tool just measures which book is softest. A sharp book is
never offered back to you as a bet.

### Two details worth knowing

**Shin's method is decreasing in z.** Σq starts at `√Σp` (above 1 for any market
with margin) and falls toward `Σp²/Σp`, so the bisection brackets `[0, 1)` and
raises its lower bound while the sum still exceeds 1. On a *two-outcome* market
Shin is algebraically identical to the additive solution — picking it over
additive for a moneyline, spread or total changes nothing. It only diverges on
three-way markets like soccer 1X2.

**Worst-case de-vig is not a probability distribution.** It returns an
independent lower bound per side, which sums to less than 1 on purpose.
Renormalising a consensus blend of those bounds would scale them straight back
up and discard the conservatism — worth roughly two points of phantom edge per
market, enough to turn a whole board green. The blend is flagged and left
un-normalised, and the odds screen says so where the numbers don't add to 100%.

## Layout

```
src/lib/odds/      american.ts (conversions, overround) · types.ts (feed model,
                   market identity) · books.ts (sharp/soft registry + weights)
                   match.ts (team/event matching for outside lines)
src/lib/ev/        devig.ts · ev.ts (EV, Kelly, CLV) · scanner.ts · arbitrage.ts
src/lib/ingest/    types.ts (payload + validation) · store.ts (TTL, per source)
                   merge.ts (attach onto the board) · pull.ts (private APIs)
                   auth.ts (shared-secret guard) · discover.ts (find an API)
scripts/discover.ts CLI: read a browser HAR, infer the endpoint and mapping
demo/              standalone browser build of the real app (no server)
src/lib/providers/ theOddsApi.ts (live) · mock.ts (demo feed) · index.ts
src/lib/cache.ts   TTL cache with in-flight request de-duplication
src/app/api/       scan · arbitrage · middles · odds · sports · ingest · sources
tests/             engine tests; the UI is a thin layer over these
```

Settings, filters and logged bets live in `localStorage`; there is no account
system and nothing is sent anywhere.

## Provider quota

Every upstream request costs credits and providers rate-limit hard, so odds are
cached server-side per (sports, markets) shape, with concurrent identical
requests de-duplicated onto a single upstream call. Scanner knobs — de-vig
method, minimum edge, bankroll — are applied *after* the fetch and deliberately
excluded from the cache key, so changing a filter in the UI never costs a
request. Raise `ODDS_CACHE_TTL_MS` if you are burning through credits.

## Known limits

- **Strict line matching.** Alternate lines are separate markets, so a book
  sitting on a number no sharp book posted is skipped rather than interpolated.
  This is a deliberate trade of coverage for correctness.
- **Player props** are modelled in the types and handled by the scanner, but The
  Odds API serves them from per-event endpoints that the provider adapter does
  not yet call.
- **No limit or staleness data.** A price that is up but unbettable, or capped
  at $20, looks identical to a real one here. Large edges are flagged as
  suspect for this reason rather than celebrated.
- **Demo data is synthetic.** It is tuned to behave like a real board — thin,
  mostly 1–3% edges, occasional dead lines — but it is not market data.
- **Custom lines live in process memory.** They are prices with a shelf life of
  seconds, not records: a restart means your scraper posts again on its next
  cycle. Running more than one server instance means each holds its own lines,
  so push to all of them or put a durable store behind the ingest route.

## Disclaimer

EdgeScan estimates value from posted prices. A de-vigged line is an estimate,
not a guarantee, and every edge assumes you can actually get the price shown.
Bet responsibly, and only where it is legal for you to do so.
