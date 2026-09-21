"""Command line interface.

    evscan init                  create evscan.toml and lines.csv
    evscan discover board.har    find your book's odds endpoint
    evscan scan                  price your board against the market
    evscan quote -- -110 -105 -108 -112    price one number, no setup
    evscan devig -- -140 +120    compare margin-removal methods
    evscan sports                list what the feed currently covers
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__, config as config_module
from .config import ConfigError
from .devig import compare
from .discover import draft_config, load_har, report
from .matching import MatchFailure
from .models import BookLine
from .oddsmath import (
    OddsError,
    american_to_decimal,
    american_to_prob,
    ev_per_unit,
    format_american,
    kelly_fraction,
    prob_to_american,
)
from .render import Style, render_csv, render_detail, render_summary, render_table, use_colour
from .scan import markets_needed, scan, sports_needed, stake_for
from .sources.book_csv import LinesError, load_lines, write_example
from .sources.the_odds_api import OddsAPIError, TheOddsAPI

EXAMPLE_TOML = '''\
# evscan configuration. Values shown are the defaults.
# Your API key does NOT go here -- it lives in the environment:
#     export ODDS_API_KEY="..."      # free key at https://the-odds-api.com

sports = ["americanfootball_nfl", "basketball_nba", "baseball_mlb", "icehockey_nhl"]

[book]
name = "MSB247"
lines_file = "lines.csv"

[market]
# How much each book's opinion counts toward the fair price.
# Sharp books dominate; retail books are a fallback for markets they miss.
devig = "multiplicative"     # multiplicative | additive | power | shin
min_books = 2                # refuse to price on fewer books than this
max_hold = 0.08              # ignore any book quoting wider than 8%
allow_fallback = true        # use retail consensus when no sharp book has it
regions = "us,us2,eu"

[market.reference_weights]
pinnacle = 1.00
circasports = 0.90
betonlineag = 0.55
lowvig = 0.55
bookmaker = 0.55

[market.fallback_weights]
draftkings = 0.30
fanduel = 0.30
betmgm = 0.22
williamhill_us = 0.22
espnbet = 0.18

[filters]
min_ev = 0.01                # 1%. Below this you are betting on noise.
min_american = -400          # skip heavy chalk
max_american = 1000          # skip lottery tickets
skip_live = true
max_hours_ahead = 240

[bankroll]
amount = 1000.0
kelly_fraction = 0.25        # quarter Kelly. Full Kelly ruins bankrolls.
max_stake_pct = 0.02         # never risk more than 2% on one bet
min_stake = 1.0
round_to = 1.0

# Uncomment after running `evscan discover` to pull your board automatically
# instead of maintaining lines.csv by hand.
# [book.http]
# enabled = true
# url = "..."
'''


def _style() -> Style:
    return Style(use_colour())


def _load_config(args) -> config_module.Config:
    return config_module.load(getattr(args, "config", None))


# --------------------------------------------------------------------- init


def cmd_init(args) -> int:
    style = _style()
    created, skipped = [], []

    toml_path = Path(args.config or "evscan.toml")
    if toml_path.exists():
        skipped.append(str(toml_path))
    else:
        toml_path.write_text(EXAMPLE_TOML, encoding="utf-8")
        created.append(str(toml_path))

    lines_path = Path("lines.csv")
    try:
        write_example(lines_path)
        created.append(str(lines_path))
    except LinesError:
        skipped.append(str(lines_path))

    for path in created:
        print(f"created {path}")
    for path in skipped:
        print(f"kept    {path} (already exists)")

    print()
    print(style("Next:", "\033[1m"))
    print("  1. Get a free key at https://the-odds-api.com, then:")
    print("       export ODDS_API_KEY='your-key'")
    print("  2. Put your book's numbers in lines.csv (or run `evscan discover`)")
    print("  3. evscan scan")
    return 0


# ----------------------------------------------------------------- discover


def cmd_discover(args) -> int:
    try:
        candidates = load_har(args.har)
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.emit_config:
        if not candidates:
            print("error: nothing to emit -- no candidate endpoint found", file=sys.stderr)
            return 1
        index = args.pick - 1
        if not 0 <= index < len(candidates):
            print(f"error: --pick {args.pick} is out of range (1..{len(candidates)})",
                  file=sys.stderr)
            return 1
        print(draft_config(candidates[index]))
        return 0

    print(report(candidates, top=args.top, verbose=args.verbose))
    return 0


# -------------------------------------------------------------------- scan


def _gather_lines(cfg: config_module.Config, args) -> list[BookLine]:
    """Prefer the live endpoint when configured, else the CSV."""
    http_cfg = cfg.http_book
    if http_cfg is not None and not args.csv:
        from .sources.book_http import HTTPBook
        return HTTPBook(http_cfg, cfg.book.name).lines()
    return load_lines(args.lines or cfg.book.lines_file, cfg.book.name)


def _fetch_events(cfg: config_module.Config, lines, args) -> tuple[list, str]:
    """Pull the sharp market for whatever sports the board actually covers."""
    api = TheOddsAPI(cfg.api_key, cache_ttl=0 if getattr(args, "no_cache", False) else 300.0)
    markets = markets_needed(lines)
    events = []
    for sport in sports_needed(lines, cfg):
        try:
            events.extend(api.odds(sport, markets=markets,
                                   regions=cfg.market.regions,
                                   use_cache=not getattr(args, "no_cache", False)))
        except OddsAPIError as exc:
            print(f"warning: {sport}: {exc}", file=sys.stderr)
    return events, api.quota.describe()


def cmd_serve(args) -> int:
    """Run the live dashboard."""
    from .dashboard import build_payload, serve
    from .movement import History

    try:
        cfg = _load_config(args)
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 1

    if args.port:
        cfg.dashboard.port = args.port
    if args.refresh:
        cfg.dashboard.refresh_seconds = args.refresh
    if args.bankroll is not None:
        cfg.bankroll.amount = args.bankroll
    if args.min_ev is not None:
        cfg.filters.min_ev = args.min_ev

    history = History(args.history)

    if not args.demo and not cfg.api_key:
        print(
            "error: ODDS_API_KEY is not set.\n"
            "  Get a free key at https://the-odds-api.com, then:\n"
            "      export ODDS_API_KEY='your-key'\n"
            "  Or see the dashboard working right now with no key:\n"
            "      python3 -m evscan serve --demo",
            file=sys.stderr,
        )
        return 1

    def scan_once() -> dict:
        if args.demo:
            from .demo import build_market
            events, lines = build_market()
            quota = "demo mode -- simulated market, no credits used"
        else:
            lines = _gather_lines(cfg, args)
            events, quota = _fetch_events(cfg, lines, args)
            if not events:
                raise RuntimeError("the odds feed returned no events")

        history.record(events)
        result = scan(lines, events, cfg, min_ev=cfg.filters.min_ev)
        # Record your book's prices too -- staleness is the comparison
        # between how far the sharps moved and how far your book did not.
        history.record_book_lines(result.matched, cfg.book.name)
        return build_payload(result, cfg, history, quota=quota)

    if args.demo:
        print("demo mode: simulated sharp market with a lagging private book")
    try:
        return serve(scan_once, cfg, open_browser=not args.no_browser)
    finally:
        history.prune()
        history.close()


def cmd_scan(args) -> int:
    style = _style()
    try:
        cfg = _load_config(args)
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 1

    if args.bankroll is not None:
        cfg.bankroll.amount = args.bankroll
    if args.devig:
        cfg.market.devig = args.devig

    try:
        lines = _gather_lines(cfg, args)
    except (LinesError, RuntimeError) as exc:
        print(f"error reading your book's lines: {exc}", file=sys.stderr)
        return 1

    if not lines:
        print("no lines to scan -- lines.csv is empty", file=sys.stderr)
        return 1

    if not cfg.api_key:
        print(
            "error: ODDS_API_KEY is not set. Get a free key at "
            "https://the-odds-api.com then:\n    export ODDS_API_KEY='your-key'",
            file=sys.stderr,
        )
        return 1

    api = TheOddsAPI(cfg.api_key, cache_ttl=0 if args.no_cache else 300.0)
    markets = markets_needed(lines)
    events = []
    for sport in sports_needed(lines, cfg):
        try:
            events.extend(
                api.odds(
                    sport,
                    markets=markets,
                    regions=cfg.market.regions,
                    use_cache=not args.no_cache,
                )
            )
        except OddsAPIError as exc:
            print(style(f"warning: {sport}: {exc}", "\033[33m"), file=sys.stderr)

    if not events:
        print("error: the odds feed returned no events", file=sys.stderr)
        return 1

    result = scan(lines, events, cfg, min_ev=args.min_ev)

    if args.csv_out:
        Path(args.csv_out).write_text(render_csv(result), encoding="utf-8")
        print(f"wrote {args.csv_out}")

    if args.format == "csv":
        print(render_csv(result), end="")
        return 0

    table = render_table(result, style, cfg.bankroll.amount)
    if table:
        print(table)
    if args.detail:
        for opp in result.opportunities:
            print()
            print(render_detail(opp, style))
    print(render_summary(result, style, api.quota.describe()))

    if args.verbose and result.failures:
        print()
        print(style("all unpriced lines:", "\033[2m"))
        for failure in result.failures:
            print(f"  - {failure.describe()}")
    return 0


# ------------------------------------------------------------------- quote


def cmd_quote(args) -> int:
    """Price one bet by hand -- no config, no API key, no CSV.

    The fastest path when you are looking at a number right now: type your
    book's price and the prices the market is showing on both sides.
    """
    style = _style()
    try:
        your = float(args.price)
        market = [float(p) for p in args.market]
    except ValueError:
        print("error: prices must be numbers, e.g. -110 +145", file=sys.stderr)
        return 1

    if len(market) < 2:
        print(
            "error: give both sides of the market, e.g.\n"
            "    evscan quote --price +145 -- +128 -140",
            file=sys.stderr,
        )
        return 1

    try:
        raw = [american_to_prob(p) for p in market]
        methods = compare(raw)
    except (OddsError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if not methods:
        print(
            "error: those prices sum to under 100% -- that is an arbitrage or a "
            "typo, not a market with margin",
            file=sys.stderr,
        )
        return 1

    decimal = american_to_decimal(your)
    overround = sum(raw) - 1.0
    print(f"your price   {format_american(your)}  (decimal {decimal:.3f})")
    print(f"market       {' '.join(format_american(p) for p in market)}"
          f"   overround {overround:.2%}")
    print()
    print(f"{'method':<16}{'fair':>9}{'true p':>10}{'EV':>10}{'¼ Kelly':>10}")
    print("-" * 55)

    evs = []
    for name, fair in methods.items():
        prob = fair[0]
        ev = ev_per_unit(prob, decimal)
        evs.append(ev)
        quarter = kelly_fraction(prob, decimal) * 0.25
        colour = "\033[32m" if ev > 0 else "\033[31m"
        # Pad before styling: ANSI escapes count toward f-string widths.
        ev_cell = style(f"{ev * 100:+.2f}%".rjust(10), colour)
        print(
            f"{name:<16}{format_american(prob_to_american(prob)):>9}{prob:>10.4f}"
            f"{ev_cell}{quarter * 100:>10.2f}%"
        )

    print()
    if min(evs) > 0:
        print(style("+EV under every method.", "\033[32m", "\033[1m"))
    elif max(evs) > 0:
        print(style(
            "Only +EV under some methods -- the edge depends on an assumption, "
            "not on the market. Treat it as a pass.", "\033[33m"))
    else:
        print(style("-EV. Do not bet it.", "\033[31m"))
    return 0


# ------------------------------------------------------------------- devig


def cmd_devig(args) -> int:
    try:
        raw = [american_to_prob(float(p)) for p in args.prices]
    except (ValueError, OddsError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    methods = compare(raw)
    if not methods:
        print("error: these prices carry no margin (sum < 100%)", file=sys.stderr)
        return 1

    print(f"raw implied  {' '.join(f'{p:.4f}' for p in raw)}   "
          f"sum {sum(raw):.4f}  overround {sum(raw) - 1:.2%}")
    print()
    for name, fair in methods.items():
        prices = " ".join(
            f"{format_american(prob_to_american(p)):>7}" for p in fair
        )
        probs = " ".join(f"{p:.4f}" for p in fair)
        print(f"{name:<16}{probs}   {prices}")
    return 0


# ------------------------------------------------------------------ sports


def cmd_sports(args) -> int:
    try:
        cfg = _load_config(args)
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 1
    if not cfg.api_key:
        print("error: ODDS_API_KEY is not set", file=sys.stderr)
        return 1

    api = TheOddsAPI(cfg.api_key)
    try:
        sports = api.sports(all_sports=args.all)
    except OddsAPIError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    for sport in sports:
        if not args.all and not sport.get("active"):
            continue
        print(f"{sport.get('key', ''):<34}{sport.get('title', '')}")
    print(f"\n{api.quota.describe()}", file=sys.stderr)
    return 0


# --------------------------------------------------------------------- main


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="evscan",
        description="Find +EV bets at a book that no odds feed covers.",
    )
    parser.add_argument("--version", action="version", version=f"evscan {__version__}")
    parser.add_argument("-c", "--config", help="path to evscan.toml")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="create evscan.toml and lines.csv")
    p_init.set_defaults(func=cmd_init)

    p_disc = sub.add_parser(
        "discover", help="find your book's odds endpoint from a browser HAR export"
    )
    p_disc.add_argument("har", help="HAR file exported from DevTools -> Network")
    p_disc.add_argument("-v", "--verbose", action="store_true",
                        help="show each candidate's payload shape")
    p_disc.add_argument("--top", type=int, default=5, help="how many candidates to show")
    p_disc.add_argument("--emit-config", action="store_true",
                        help="print a [book.http] config block instead of a report")
    p_disc.add_argument("--pick", type=int, default=1,
                        help="which candidate to emit config for (default: 1)")
    p_disc.set_defaults(func=cmd_discover)

    p_scan = sub.add_parser("scan", help="price your board against the market")
    p_scan.add_argument("-l", "--lines", help="path to your lines CSV")
    p_scan.add_argument("--csv", action="store_true",
                        help="force the CSV source even if book.http is configured")
    p_scan.add_argument("--min-ev", type=float, help="EV threshold, e.g. 0.02 for 2%%")
    p_scan.add_argument("--bankroll", type=float, help="override bankroll for sizing")
    p_scan.add_argument("--devig", choices=("multiplicative", "additive", "power", "shin"))
    p_scan.add_argument("-d", "--detail", action="store_true",
                        help="show the full reasoning for each bet")
    p_scan.add_argument("-v", "--verbose", action="store_true",
                        help="list every line that could not be priced")
    p_scan.add_argument("--format", choices=("table", "csv"), default="table")
    p_scan.add_argument("--csv-out", help="also write results to this CSV file")
    p_scan.add_argument("--no-cache", action="store_true",
                        help="bypass the disk cache (costs an API credit)")
    p_scan.set_defaults(func=cmd_scan)

    p_quote = sub.add_parser(
        "quote", help="price a single bet by hand, no setup required"
    )
    p_quote.add_argument("-p", "--price", required=True,
                         help="your book's price, e.g. +145")
    p_quote.add_argument("market", nargs="+",
                         help="the market's prices, both sides, e.g. +128 -140")
    p_quote.set_defaults(func=cmd_quote)

    p_devig = sub.add_parser("devig", help="compare margin-removal methods on a market")
    p_devig.add_argument("prices", nargs="+", help="every side, e.g. -140 +120")
    p_devig.set_defaults(func=cmd_devig)

    p_serve = sub.add_parser("serve", help="run the live edge dashboard")
    p_serve.add_argument("--demo", action="store_true",
                         help="simulated market; no API key or book feed needed")
    p_serve.add_argument("-p", "--port", type=int, help="port (default 8000)")
    p_serve.add_argument("--refresh", type=float,
                         help="seconds between re-pricing (default 45)")
    p_serve.add_argument("--min-ev", type=float, help="EV threshold, e.g. 0.02")
    p_serve.add_argument("--bankroll", type=float, help="override bankroll")
    p_serve.add_argument("-l", "--lines", help="path to your lines CSV")
    p_serve.add_argument("--csv", action="store_true",
                         help="force the CSV source even if book.http is set")
    p_serve.add_argument("--history", default=".evscan-history.db",
                         help="where line history is kept")
    p_serve.add_argument("--no-browser", action="store_true",
                         help="do not open a browser window")
    p_serve.add_argument("--no-cache", action="store_true")
    p_serve.set_defaults(func=cmd_serve)

    p_sports = sub.add_parser("sports", help="list sports the feed covers")
    p_sports.add_argument("--all", action="store_true", help="include out-of-season")
    p_sports.set_defaults(func=cmd_sports)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
