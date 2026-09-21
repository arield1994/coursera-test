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
npm test             # 54 tests over the odds/EV/arbitrage engine
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
src/lib/ev/        devig.ts · ev.ts (EV, Kelly, CLV) · scanner.ts · arbitrage.ts
src/lib/providers/ theOddsApi.ts (live) · mock.ts (demo feed) · index.ts
src/lib/cache.ts   TTL cache with in-flight request de-duplication
src/app/api/       scan · arbitrage · middles · odds · sports
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

## Disclaimer

EdgeScan estimates value from posted prices. A de-vigged line is an estimate,
not a guarantee, and every edge assumes you can actually get the price shown.
Bet responsibly, and only where it is legal for you to do so.
