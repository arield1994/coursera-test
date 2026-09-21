# evscan

A +EV scanner for a sportsbook that no odds feed covers.

Most EV tools only work with books that have public APIs. MSB247 and other
agent / pay-per-head platforms do not — they are private, login-only, and
absent from every odds aggregator. `evscan` closes that gap: it takes the
prices **your** book shows you, prices them against the de-vigged sharp
market, and tells you which numbers are worth betting and how much.

Stdlib only. No dependencies to install (pytest for the tests).

```
$ evscan scan

MATCHUP                                 BET                     YOURS  FAIR   EV       STAKE  BOOKS  FLAG
--------------------------------------  ----------------------  -----  -----  -------  -----  -----  ------
Buffalo Bills @ Kansas City  Sat 17:00  Buffalo Bills           +145   +133   +5.18%   45     3      solid
Boston Celtics @ Denver Nug  Sat 23:30  Celtics                 +120   +110   +4.78%   50     2      thin

2 of 6 lines cleared the threshold. Total stake 95.00, expected profit +4.72.
2 line(s) could not be priced:
  - Buffalo Bills @ Kansas City Chiefs / Buffalo Bills +7.5: no reference book
    prices this selection (2 book(s) without this exact number)
odds feed: 487 credits left (used 13)
```

## Setup

```bash
git clone <this repo> && cd coursera-test
evscan() { python3 -m evscan "$@"; }     # or add an alias

export ODDS_API_KEY='...'                # free: https://the-odds-api.com
python3 -m evscan init                   # writes evscan.toml + lines.csv
```

## Getting your book's prices in

Your book's board has to come from you. There are three ways, in increasing
order of effort and payoff.

### 1. One number at a time — no setup at all

You are looking at a price right now and want to know if it is good:

```bash
python3 -m evscan quote --price +145 -- +128 -140
#                        ^your book     ^what the market shows, both sides
```

```
method               fair    true p        EV   ¼ Kelly
-------------------------------------------------------
multiplicative       +133    0.4292    +5.15%      0.89%
additive             +134    0.4276    +4.77%      0.82%
power                +134    0.4269    +4.59%      0.79%
shin                 +134    0.4276    +4.77%      0.82%

+EV under every method.
```

If an edge only survives under *some* de-vig methods, it is an artifact of
the assumption rather than a property of the market. The tool says so.

### 2. A CSV you maintain

`lines.csv` — column names are flexible (`ml`/`moneyline`/`h2h` all work,
as do `price`/`odds`, `limit`/`max_stake`):

```csv
sport,commence_time,away_team,home_team,market,selection,point,price,limit
nfl,2026-09-27 17:00,Buffalo Bills,Kansas City Chiefs,ml,Buffalo Bills,,+145,500
nfl,2026-09-27 17:00,Buffalo Bills,Kansas City Chiefs,total,Over,47.5,-105,500
```

Then `python3 -m evscan scan`.

### 3. Straight from your book's own endpoint

Your book's front-end fetches its odds from somewhere. Find that endpoint
once and the CSV goes away.

1. Log in to your book in Chrome. Open DevTools (F12) → **Network**.
2. Tick **Preserve log**, then hard-refresh (Ctrl-Shift-R) with the odds
   board open.
3. Right-click the request list → **Save all as HAR with content**.
4. Point evscan at it:

```bash
python3 -m evscan discover board.har --verbose
```

It ranks every captured request by how much it looks like odds data
(rotation numbers, wager types, American-odds-shaped values), shows you the
payload shape, and drafts the adapter config:

```bash
python3 -m evscan discover board.har --emit-config >> evscan.toml
export BOOK_AUTH='<the cookie value from that request>'
python3 -m evscan scan
```

Server-rendered boards (plenty of these platforms are ASP.NET WebForms with
no JSON call at all) are supported too — set `parse = "html"`.

> **Your HAR file contains live session cookies.** Anyone holding it can act
> as you on that site. `evscan discover` never prints those values and never
> writes them to config, `.har` is gitignored, and credentials are read from
> environment variables only. Don't paste a HAR into a chat window — mine
> included.
>
> Automating requests against a site is also commonly against its terms of
> service, whatever your account status. That call is yours to make.

## How a price is judged

1. **Collect** every book's market from the feed (Pinnacle, Circa, BetOnline
   weighted heavily; retail books as fallback).
2. **Reject** books quoting wider than `max_hold`, and any market missing a
   side — a one-sided market cannot be de-vigged.
3. **De-vig** each book's market to fair probabilities.
4. **Blend** them by weight into a consensus, keeping the highest and lowest
   book opinions.
5. **Compare** your book's price to that consensus: `EV = p × decimal − 1`.
6. **Size** it at a fraction of Kelly, capped by bankroll percentage and by
   your account's limit.

### What it refuses to do

These refusals are the point. Each one is a fake edge it declines to show you:

- **Price a number no book offers.** Your +7.5 against the market's +3.5 is
  a different bet. Skipped and reported, never interpolated.
- **Match teams it isn't sure about.** "NY Giants" never matches "San
  Francisco Giants"; ambiguous matchups are rejected rather than guessed.
- **Trust a single method.** Each opportunity reports EV under the least
  friendly reference book as well as the consensus.
- **Hide thin markets.** Fewer than three books, or books disagreeing by more
  than 3%, gets flagged `thin`. A +2% edge over a market that disagrees with
  itself by 4% is noise.

Flags: `solid` · `thin` (few books / wide disagreement) · `fragile` (−EV
under the least friendly book).

## Commands

| Command | What it does |
|---|---|
| `evscan init` | Write `evscan.toml` and a starter `lines.csv` |
| `evscan quote -p +145 -- +128 -140` | Price one bet, no setup |
| `evscan devig -- -140 +120` | Compare all four margin-removal methods |
| `evscan discover board.har` | Find your book's odds endpoint |
| `evscan scan` | Price your whole board |
| `evscan scan -d` | ...with the full reasoning per bet |
| `evscan scan --csv-out bets.csv` | ...and log it for closing-line tracking |
| `evscan sports` | What the feed currently covers |

## Configuration

`evscan.toml`, created by `init`. The defaults worth knowing:

```toml
[market]
devig = "multiplicative"   # multiplicative | additive | power | shin
min_books = 2              # refuse to price on fewer
max_hold = 0.08            # ignore books quoting wider than 8%

[filters]
min_ev = 0.01              # below 1% you are betting on noise
min_american = -400        # skip heavy chalk
max_american = 1000        # skip lottery tickets

[bankroll]
amount = 1000.0
kelly_fraction = 0.25      # quarter Kelly
max_stake_pct = 0.02       # never risk more than 2% on one bet
```

**On the de-vig method.** It matters more than it looks. On a −2000/+1100
market the four methods put the longshot's fair price anywhere from +1143 to
+1709. Run `evscan devig` on a market before trusting an edge on it. `power`
is the better default for heavy favourites; `multiplicative` for roughly
balanced two-way markets.

**On Kelly.** Full Kelly assumes your probability is exactly right. It never
is. Quarter Kelly with a 2% cap is the default for that reason.

## Reality check

The free Odds API tier is 500 credits/month, and a credit is charged *per
region per market* — `regions = "us,us2,eu"` with two markets costs 6 per
call. Responses are cached on disk for 5 minutes, so re-running a scan is
free. Budget accordingly, or narrow `regions`.

Edges at a book like this are usually stale lines, and books notice. Your
limits are more likely to get cut than your model is to be wrong. Log your
bets (`--csv-out`) and track closing-line value — CLV is the only honest
evidence that any of this works.

## Tests

```bash
pip install pytest && python3 -m pytest tests/ -q
```

51 tests, covering the places where being wrong costs money: odds
conversion, all four de-vig methods, team matching false-positives, refusal
to price mismatched numbers, and stake caps.
