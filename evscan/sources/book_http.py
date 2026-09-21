"""Pulling your book's board straight from its own endpoint.

Config-driven, because your book's API is undocumented and nothing about its
shape can be assumed. `evscan discover` reads a HAR export and writes the
[book.http] block; this module executes it.

    [book.http]
    enabled = true
    url     = "https://example.com/Sportsbook/GetLines"
    method  = "POST"
    parse   = "json"              # or "html" for a server-rendered board

    [book.http.headers]
    Cookie = "${BOOK_AUTH}"       # ${VAR} reads the environment at run time

    [book.http.mapping]
    groups     = "d.Leagues[*].Games[*]"   # outer loop: one per game
    rows       = "Lines[*]"                # inner loop: one per price
    away_team  = "AwayTeam"                # resolved row -> group -> root
    american   = "Price"

Credentials live in the environment and are never written to config, never
logged, and never included in an error message.
"""

from __future__ import annotations

import gzip
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any

from ..jsonpath import select, select_one
from ..models import BookLine
from .book_csv import LinesError, normalize_market, normalize_sport

ENV_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
DEFAULT_TIMEOUT = 25.0
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

REQUIRED_MAPPING = ("rows", "selection", "american")


class BookHTTPError(RuntimeError):
    """Raised when the book's endpoint cannot be read."""


@dataclass
class HTTPBookConfig:
    """The [book.http] block, validated."""

    url: str
    method: str = "GET"
    parse: str = "json"
    enabled: bool = False
    headers: dict[str, str] = None
    params: dict[str, str] = None
    body: str = ""
    mapping: dict[str, str] = None
    sport: str = ""
    table_index: int = 0
    min_interval: float = 2.0     # be a good citizen; this is not a scraper farm

    def __post_init__(self) -> None:
        self.headers = dict(self.headers or {})
        self.params = dict(self.params or {})
        self.mapping = dict(self.mapping or {})
        self.method = self.method.upper()
        if self.parse not in ("json", "html"):
            raise BookHTTPError(f"book.http.parse must be 'json' or 'html', got {self.parse!r}")
        if not self.url:
            raise BookHTTPError("book.http.url is required")
        missing = [k for k in REQUIRED_MAPPING if not self.mapping.get(k)]
        if missing:
            raise BookHTTPError(
                "book.http.mapping is missing: " + ", ".join(missing) +
                ". Run `evscan discover <file.har> --verbose` to see the payload "
                "shape and fill these in."
            )

    @classmethod
    def from_dict(cls, raw: dict) -> "HTTPBookConfig":
        known = {f for f in cls.__dataclass_fields__}
        unknown = set(raw) - known
        if unknown:
            raise BookHTTPError(
                f"unknown key(s) in [book.http]: {', '.join(sorted(unknown))}"
            )
        return cls(**raw)


def expand_env(value: str) -> str:
    """Substitute ${VAR} from the environment. Missing vars are an error."""
    def replace(match: re.Match) -> str:
        name = match.group(1)
        found = os.environ.get(name)
        if found is None:
            raise BookHTTPError(
                f"{name} is referenced in config but not set. Export it first:\n"
                f"    export {name}='<value from your browser>'"
            )
        return found
    return ENV_PATTERN.sub(replace, value)


class _TableParser(HTMLParser):
    """Extract table rows from a server-rendered board.

    Plenty of agent platforms are ASP.NET WebForms that render the whole
    board as HTML with no JSON call to intercept. Those get parsed here.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        self._table: list[list[str]] | None = None
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "table":
            self._table = []
        elif tag == "tr" and self._table is not None:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None and self._table is not None:
            if any(cell for cell in self._row):
                self._table.append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            if self._table:
                self.tables.append(self._table)
            self._table = None

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)


def _html_to_rows(html: str, table_index: int) -> list[dict[str, str]]:
    """Turn a table into dicts keyed col0, col1, ... so mapping paths work."""
    parser = _TableParser()
    parser.feed(html)
    if not parser.tables:
        raise BookHTTPError("no <table> found in the response")
    if table_index >= len(parser.tables):
        raise BookHTTPError(
            f"table_index {table_index} out of range; the page has "
            f"{len(parser.tables)} table(s)"
        )
    table = parser.tables[table_index]
    return [
        {f"col{i}": cell for i, cell in enumerate(row)}
        for row in table
    ]


class HTTPBook:
    """Fetches and maps your book's board."""

    def __init__(self, config: HTTPBookConfig, book_name: str = "MSB247") -> None:
        self.config = config
        self.book_name = book_name
        self._last_request = 0.0

    def fetch_raw(self) -> tuple[Any, str]:
        """Perform the request. Returns (parsed_or_none, raw_text)."""
        cfg = self.config

        # Politeness: never burst against someone else's server.
        elapsed = time.monotonic() - self._last_request
        if elapsed < cfg.min_interval:
            time.sleep(cfg.min_interval - elapsed)

        url = cfg.url
        params = {k: expand_env(v) for k, v in cfg.params.items()}
        data = None
        if cfg.method == "GET":
            if params:
                url = f"{url}?{urllib.parse.urlencode(params)}"
        else:
            if cfg.body:
                data = expand_env(cfg.body).encode("utf-8")
            elif params:
                data = urllib.parse.urlencode(params).encode("utf-8")

        headers = {k: expand_env(v) for k, v in cfg.headers.items()}
        headers.setdefault("User-Agent", DEFAULT_USER_AGENT)
        headers.setdefault("Accept-Encoding", "gzip")
        if data and "Content-Type" not in headers:
            headers["Content-Type"] = (
                "application/json" if cfg.body.strip().startswith(("{", "["))
                else "application/x-www-form-urlencoded"
            )

        request = urllib.request.Request(
            url, data=data, headers=headers, method=cfg.method
        )
        try:
            with urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT) as response:
                payload = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    payload = gzip.decompress(payload)
                text = payload.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            self._last_request = time.monotonic()
            if exc.code in (401, 403):
                raise BookHTTPError(
                    f"the book rejected the request ({exc.code}). Your session has "
                    "almost certainly expired -- log in again, re-copy the cookie, "
                    "and re-export BOOK_AUTH. Sessions on these platforms are "
                    "usually short-lived."
                ) from None
            if exc.code == 429:
                raise BookHTTPError(
                    "rate limited (429). Raise book.http.min_interval and scan less often."
                ) from None
            raise BookHTTPError(f"book endpoint returned HTTP {exc.code}") from None
        except urllib.error.URLError as exc:
            self._last_request = time.monotonic()
            raise BookHTTPError(f"could not reach the book: {exc.reason}") from None

        self._last_request = time.monotonic()

        if cfg.parse == "html":
            return None, text
        try:
            return json.loads(text), text
        except json.JSONDecodeError:
            snippet = text.strip()[:200]
            if snippet.lower().startswith(("<!doctype", "<html")):
                raise BookHTTPError(
                    "got an HTML page where JSON was expected -- this is usually a "
                    "login redirect, meaning the session is dead. Refresh BOOK_AUTH, "
                    "or set parse = \"html\" if the board really is server-rendered."
                ) from None
            raise BookHTTPError(f"response was not valid JSON: {snippet!r}") from None

    def lines(self) -> list[BookLine]:
        """Fetch the board and map it into BookLine rows."""
        parsed, text = self.fetch_raw()
        cfg = self.config
        mapping = cfg.mapping

        if cfg.parse == "html":
            rows = [(row, {}) for row in _html_to_rows(text, cfg.table_index)]
        else:
            rows = []
            groups_path = mapping.get("groups", "")
            if groups_path:
                for group in select(parsed, groups_path):
                    for row in select(group, mapping["rows"]):
                        rows.append((row, group))
            else:
                for row in select(parsed, mapping["rows"]):
                    rows.append((row, {}))

        if not rows:
            raise BookHTTPError(
                f"mapping matched no rows (rows = {mapping['rows']!r}). The payload "
                "shape may have changed -- re-run `evscan discover` on a fresh HAR."
            )

        out: list[BookLine] = []
        skipped = 0
        for row, group in rows:
            try:
                out.append(self._to_line(row, group, parsed))
            except (LinesError, BookHTTPError, ValueError):
                skipped += 1        # header rows and blank cells are expected
        if not out:
            raise BookHTTPError(
                f"matched {len(rows)} rows but none produced a usable price. Check "
                "the field paths in [book.http.mapping] against `evscan discover "
                "--verbose`."
            )
        return out

    # ---------------------------------------------------------------- mapping

    def _resolve(self, field: str, row: Any, group: Any, root: Any) -> Any:
        """Row first, then the enclosing group, then the document root."""
        path = self.config.mapping.get(field, "")
        if not path:
            return None
        if path.startswith("="):        # literal value, e.g. market = "=spreads"
            return path[1:]
        for scope in (row, group, root):
            if scope is None:
                continue
            found = select_one(scope, path)
            if found is not None:
                return found
        return None

    def _to_line(self, row: Any, group: Any, root: Any) -> BookLine:
        get = lambda field: self._resolve(field, row, group, root)

        price_raw = get("american")
        if price_raw is None or str(price_raw).strip() in ("", "-", "--"):
            raise ValueError("no price")
        price = _coerce_american(price_raw)

        selection = str(get("selection") or "").strip()
        if not selection:
            raise ValueError("no selection")

        point_raw = get("point")
        point = _coerce_point(point_raw)

        market = normalize_market(str(get("market") or ""))
        if market not in ("h2h", "spreads", "totals"):
            # Infer from the shape of the row when the book's label is unknown.
            market = "totals" if selection.lower() in ("over", "under") else (
                "spreads" if point is not None else "h2h"
            )

        sport = normalize_sport(str(get("sport") or self.config.sport or ""))
        return BookLine(
            book=self.book_name,
            sport=sport,
            away_team=str(get("away_team") or "").strip(),
            home_team=str(get("home_team") or "").strip(),
            market=market,
            selection=selection,
            american=price,
            point=point,
            commence_time=_coerce_time(get("commence_time")),
            max_stake=_coerce_float(get("max_stake")),
            note="via book.http",
        )


def _coerce_american(value: Any) -> float:
    text = str(value).strip().replace(" ", "").replace(",", "")
    if text.lower() in ("ev", "even", "pk", "pick"):
        return 100.0
    price = float(text)
    if -100 < price < 100:
        if 1.0 < price < 100.0:     # decimal odds
            from ..oddsmath import decimal_to_american
            return decimal_to_american(price)
        raise ValueError(f"{value!r} is not valid American odds")
    return price


def _coerce_point(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip().replace(" ", "")
    if not text or text in ("-", "--", "None"):
        return None
    if text.lower() in ("pk", "pick", "ev", "even"):
        return 0.0
    text = re.sub(r"^[ouOU]", "", text)
    try:
        return float(text)
    except ValueError:
        return None


def _coerce_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(str(value).replace(",", "").replace("$", "").strip())
    except ValueError:
        return None


def _coerce_time(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        seconds = value / 1000.0 if value > 1e11 else float(value)
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    # ASP.NET "/Date(1730000000000)/"
    aspnet = re.match(r"/Date\((-?\d+)", text)
    if aspnet:
        return datetime.fromtimestamp(int(aspnet.group(1)) / 1000.0, tz=timezone.utc)
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M",
                "%m/%d/%Y %I:%M %p", "%m/%d/%Y %H:%M", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None
