"""Reading your own book's lines from a CSV.

MSB247 is an agent / pay-per-head book: it has no public API and appears in
no odds feed, so its prices have to come from you. Open your board, type (or
paste) what you see into lines.csv, and the scanner prices it against the
sharp market.

The reader is deliberately forgiving about headers, because a file you
maintain by hand at 11pm should not fail on a column name:

    required : market, selection, american
    matchup  : either `away_team` + `home_team`, or a single `matchup`
               column written "Away @ Home"
    optional : sport, commence_time, point, max_stake, note

Aliases accepted: price/odds -> american, line/spread/total -> point,
team/pick/bet -> selection, game/event -> matchup, date/start -> commence_time.
"""

from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path

from ..models import BookLine

ALIASES = {
    "american": "american",
    "price": "american",
    "odds": "american",
    "american_odds": "american",
    "point": "point",
    "line": "point",
    "spread": "point",
    "total": "point",
    "number": "point",
    "selection": "selection",
    "team": "selection",
    "pick": "selection",
    "bet": "selection",
    "side": "selection",
    "market": "market",
    "type": "market",
    "bet_type": "market",
    "matchup": "matchup",
    "game": "matchup",
    "event": "matchup",
    "away_team": "away_team",
    "away": "away_team",
    "home_team": "home_team",
    "home": "home_team",
    "sport": "sport",
    "league": "sport",
    "commence_time": "commence_time",
    "date": "commence_time",
    "start": "commence_time",
    "start_time": "commence_time",
    "max_stake": "max_stake",
    "limit": "max_stake",
    "max": "max_stake",
    "note": "note",
    "notes": "note",
    "comment": "note",
}

# What users type -> the market key the odds feed uses.
MARKET_ALIASES = {
    "ml": "h2h",
    "moneyline": "h2h",
    "money_line": "h2h",
    "h2h": "h2h",
    "win": "h2h",
    "spread": "spreads",
    "spreads": "spreads",
    "ats": "spreads",
    "runline": "spreads",
    "run_line": "spreads",
    "puckline": "spreads",
    "puck_line": "spreads",
    "handicap": "spreads",
    "total": "totals",
    "totals": "totals",
    "ou": "totals",
    "over_under": "totals",
}

SPORT_ALIASES = {
    "nfl": "americanfootball_nfl",
    "ncaaf": "americanfootball_ncaaf",
    "cfb": "americanfootball_ncaaf",
    "nba": "basketball_nba",
    "ncaab": "basketball_ncaab",
    "cbb": "basketball_ncaab",
    "wnba": "basketball_wnba",
    "mlb": "baseball_mlb",
    "nhl": "icehockey_nhl",
    "epl": "soccer_epl",
    "mls": "soccer_usa_mls",
    "ufc": "mma_mixed_martial_arts",
    "mma": "mma_mixed_martial_arts",
    "boxing": "boxing_boxing",
}


class LinesError(ValueError):
    """Raised when the lines file cannot be read as written."""

    def __init__(self, message: str, row: int | None = None) -> None:
        self.row = row
        super().__init__(f"line {row}: {message}" if row else message)


def normalize_market(value: str) -> str:
    key = value.strip().lower().replace(" ", "_").replace("-", "_")
    return MARKET_ALIASES.get(key, key)


def normalize_sport(value: str) -> str:
    key = value.strip().lower().replace(" ", "_").replace("-", "_")
    return SPORT_ALIASES.get(key, key)


def _parse_american(value: str, row: int) -> float:
    text = value.strip().replace(" ", "")
    if not text:
        raise LinesError("missing price", row)
    # "EV" / "even" / "pk" are how a board writes +100.
    if text.lower() in ("ev", "even", "pk", "pick"):
        return 100.0
    try:
        price = float(text)
    except ValueError:
        raise LinesError(f"price {value!r} is not a number", row) from None
    if -100 < price < 100:
        # Decimal odds slipped in: 1.91 rather than -110.
        if 1.0 < price < 100.0:
            from ..oddsmath import decimal_to_american
            return decimal_to_american(price)
        raise LinesError(f"price {value!r} is not valid American odds", row)
    return price


def _parse_point(value: str, row: int) -> float | None:
    text = value.strip().replace(" ", "")
    if not text or text.lower() in ("pk", "pick", "ev", "even"):
        return 0.0 if text else None
    text = text.lstrip("ou").lstrip("OU")
    try:
        return float(text)
    except ValueError:
        raise LinesError(f"line {value!r} is not a number", row) from None


def _parse_time(value: str, row: int) -> datetime | None:
    text = value.strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%m/%d/%Y %H:%M", "%m/%d/%Y"):
        try:
            parsed = datetime.strptime(text, fmt)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        raise LinesError(f"could not read date {value!r}", row) from None


def _split_matchup(value: str, row: int) -> tuple[str, str]:
    for sep in (" @ ", " at ", " vs ", " v ", "@"):
        if sep in value:
            away, home = value.split(sep, 1)
            return away.strip(), home.strip()
    raise LinesError(
        f"matchup {value!r} must be written 'Away @ Home' (or give "
        "away_team and home_team columns)",
        row,
    )


def _strip_comments(lines):
    """Yield CSV lines, skipping blank lines and those starting with '#'."""
    for line in lines:
        stripped = line.lstrip("\ufeff").strip()
        if not stripped or stripped.startswith("#"):
            continue
        yield line


def load_lines(path: str | Path, book_name: str = "MSB247") -> list[BookLine]:
    """Read your book's lines. Raises LinesError on a row that cannot be used."""
    file_path = Path(path).expanduser()
    if not file_path.exists():
        raise LinesError(
            f"lines file not found: {file_path}. Run `evscan init` to create a "
            "starter file, then fill in what your board shows."
        )

    with file_path.open(newline="", encoding="utf-8-sig") as fh:
        # Drop whole-line comments so the file can carry its own instructions.
        reader = csv.DictReader(_strip_comments(fh))
        if not reader.fieldnames:
            raise LinesError(f"{file_path} has no header row")

        mapping = {}
        for field_name in reader.fieldnames:
            key = (field_name or "").strip().lower().replace(" ", "_")
            if key in ALIASES:
                mapping[field_name] = ALIASES[key]

        canonical = set(mapping.values())
        for required in ("market", "selection", "american"):
            if required not in canonical:
                raise LinesError(
                    f"{file_path} is missing a {required!r} column "
                    f"(found: {', '.join(reader.fieldnames)})"
                )
        if "matchup" not in canonical and not {"away_team", "home_team"} <= canonical:
            raise LinesError(
                f"{file_path} needs either a 'matchup' column or both "
                "'away_team' and 'home_team'"
            )

        lines: list[BookLine] = []
        for row_number, raw_row in enumerate(reader, start=2):
            row = {
                mapping[k]: (v or "")
                for k, v in raw_row.items()
                if k in mapping
            }
            if not any(value.strip() for value in row.values()):
                continue  # blank separator row
            if row.get("selection", "").strip().startswith("#"):
                continue  # commented out

            if row.get("away_team", "").strip() and row.get("home_team", "").strip():
                away, home = row["away_team"].strip(), row["home_team"].strip()
            else:
                away, home = _split_matchup(row.get("matchup", "").strip(), row_number)

            max_stake_raw = row.get("max_stake", "").strip()
            lines.append(
                BookLine(
                    book=book_name,
                    sport=normalize_sport(row.get("sport", "")),
                    away_team=away,
                    home_team=home,
                    market=normalize_market(row["market"]),
                    selection=row["selection"].strip(),
                    american=_parse_american(row["american"], row_number),
                    point=_parse_point(row.get("point", ""), row_number),
                    commence_time=_parse_time(row.get("commence_time", ""), row_number),
                    max_stake=float(max_stake_raw) if max_stake_raw else None,
                    note=row.get("note", "").strip(),
                )
            )
    return lines


EXAMPLE_CSV = """\
# Your book's board. One row per price you can actually bet.
# market: ml | spread | total     selection: team name, or Over / Under
# point:  the spread or total (blank for moneylines)
# price:  American odds exactly as shown (-110, +145, EV)
sport,commence_time,away_team,home_team,market,selection,point,price,limit,note
nfl,2026-09-27 17:00,Buffalo Bills,Kansas City Chiefs,ml,Buffalo Bills,,+145,500,
nfl,2026-09-27 17:00,Buffalo Bills,Kansas City Chiefs,spread,Buffalo Bills,+3.5,-105,500,
nfl,2026-09-27 17:00,Buffalo Bills,Kansas City Chiefs,total,Over,47.5,-105,500,
nba,2026-09-28 23:30,Boston Celtics,Denver Nuggets,ml,Boston Celtics,,+120,300,
"""


def write_example(path: str | Path) -> Path:
    """Write a starter lines file. Refuses to clobber an existing one."""
    file_path = Path(path).expanduser()
    if file_path.exists():
        raise LinesError(f"{file_path} already exists; not overwriting it")
    file_path.write_text(EXAMPLE_CSV, encoding="utf-8")
    return file_path
