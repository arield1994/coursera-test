"""Finding your book's private odds endpoint from a browser HAR export.

Your book has no public API and no documentation, so rather than guess at
its internals, let the site tell us. You log in, load your board, export the
network traffic, and this module finds the request that carried the odds and
drafts the adapter config for it.

    1. Log in to your book in Chrome or Firefox.
    2. Open DevTools (F12) -> Network tab. Tick "Preserve log".
    3. Load / refresh the odds board so the requests are captured.
    4. Right-click the request list -> "Save all as HAR with content".
    5. evscan discover board.har

SECURITY, and this is not boilerplate: a HAR file contains your session
cookies and auth headers in plaintext. Anyone holding it can act as you on
that site until the session expires. This module never prints those values
-- it reports only *which* header carries auth -- and `evscan discover`
writes no secrets into config. Keep the .har out of the repo (it is
gitignored), and do not paste one into a chat window, mine included.

Note that automating requests against a site is very often against its terms
of service, whatever your account status. That is your call to make; this
tool just reads a file you exported.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from .jsonpath import shape, walk

# Words in a URL that suggest a betting board rather than telemetry.
URL_SIGNALS = {
    "odds": 5, "line": 5, "lines": 5, "board": 5, "offering": 5, "market": 4,
    "wager": 4, "bet": 3, "sport": 3, "event": 3, "game": 3, "schedule": 3,
    "matchup": 3, "contest": 3, "league": 2, "live": 2, "getlines": 6,
    "getodds": 6, "getschedule": 5, "openbets": 2,
}

URL_NOISE = {
    "analytics", "telemetry", "gtag", "collect", "beacon", "pixel", "sentry",
    "hotjar", "doubleclick", "facebook", "recaptcha", "fonts", "cdn-cgi",
    "heartbeat", "ping", "log",
}

# Keys in a payload that betting data has and telemetry does not.
KEY_SIGNALS = {
    "rotation": 8,      # rotation numbers are near-conclusive for a US book
    "rotnum": 8, "rot": 6,
    "moneyline": 7, "money_line": 7, "spread": 6, "total": 5, "juice": 6,
    "odds": 5, "price": 4, "line": 4, "handicap": 5, "over": 3, "under": 3,
    "hometeam": 5, "awayteam": 5, "home_team": 5, "away_team": 5,
    "teamname": 4, "gamedate": 4, "gametime": 4, "starttime": 3,
    "period": 3, "sportid": 4, "leagueid": 3, "eventid": 3, "wagertype": 5,
}

AUTH_HEADERS = {
    "cookie", "authorization", "x-auth-token", "x-access-token", "x-api-key",
    "x-session-id", "x-csrf-token", "x-xsrf-token", "authtoken", "token",
}

# An integer that could be a US price. Used as corroborating evidence only.
AMERICAN_ODDS = re.compile(r"(?<![\d.])[-+](?:[1-9]\d{2}|100)(?![\d.])")


@dataclass
class Candidate:
    """One captured request that might be the odds feed."""

    url: str
    method: str
    status: int
    mime: str
    size: int
    score: float
    reasons: list[str] = field(default_factory=list)
    auth_headers: list[str] = field(default_factory=list)
    body: object | None = None
    query: dict[str, str] = field(default_factory=dict)
    post_data: str = ""

    @property
    def path(self) -> str:
        parsed = urlparse(self.url)
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"

    @property
    def is_json(self) -> bool:
        return self.body is not None


def _redact(value: str) -> str:
    """Never echo a credential. Report only its shape."""
    return f"<redacted, {len(value)} chars>"


def _score_url(url: str) -> tuple[float, list[str]]:
    lowered = url.lower()
    score, reasons = 0.0, []
    for word in URL_NOISE:
        if word in lowered:
            return -50.0, [f"looks like third-party/telemetry traffic ({word})"]
    for word, weight in URL_SIGNALS.items():
        if word in lowered:
            score += weight
            reasons.append(f"url contains {word!r}")
    return score, reasons


def _score_body(body: object, text: str) -> tuple[float, list[str]]:
    score, reasons = 0.0, []
    hits: dict[str, int] = {}
    for path, _value in walk(body):
        leaf = path.split(".")[-1].replace("[*]", "").lower()
        normalized = leaf.replace("_", "").replace("-", "")
        for signal, weight in KEY_SIGNALS.items():
            if signal.replace("_", "") == normalized or signal == leaf:
                hits[signal] = hits.get(signal, 0) + 1
                score += weight
                break
    if hits:
        top = sorted(hits, key=lambda k: -KEY_SIGNALS[k])[:5]
        reasons.append(f"payload has betting fields: {', '.join(top)}")

    prices = len(AMERICAN_ODDS.findall(text))
    if prices >= 4:
        score += min(12.0, prices * 0.5)
        reasons.append(f"{prices} values look like American odds")
    return score, reasons


def load_har(path: str | Path) -> list[Candidate]:
    """Parse a HAR export into scored candidates, best first."""
    file_path = Path(path).expanduser()
    if not file_path.exists():
        raise FileNotFoundError(f"HAR file not found: {file_path}")

    with file_path.open(encoding="utf-8", errors="replace") as fh:
        har = json.load(fh)

    entries = har.get("log", {}).get("entries", [])
    if not entries:
        raise ValueError(f"{file_path} contains no captured requests")

    candidates: list[Candidate] = []
    for entry in entries:
        request = entry.get("request", {})
        response = entry.get("response", {})
        url = request.get("url", "")
        if not url or url.startswith("data:"):
            continue

        content = response.get("content", {})
        mime = (content.get("mimeType") or "").split(";")[0]
        text = content.get("text") or ""
        status = response.get("status", 0)

        # Assets can never be the odds feed.
        if mime.startswith(("image/", "font/", "video/", "audio/")):
            continue
        if mime in ("text/css", "application/javascript", "text/javascript"):
            continue

        url_score, reasons = _score_url(url)
        if url_score <= -50:
            continue

        body = None
        body_score, body_reasons = 0.0, []
        if text:
            try:
                body = json.loads(text)
                body_score, body_reasons = _score_body(body, text)
                body_score += 4.0
                body_reasons.append("response is JSON")
            except (json.JSONDecodeError, ValueError):
                if "html" in mime:
                    prices = len(AMERICAN_ODDS.findall(text))
                    if prices >= 8:
                        body_score += min(10.0, prices * 0.3)
                        body_reasons.append(
                            f"server-rendered HTML with {prices} odds-like values"
                        )

        auth = [
            header.get("name", "")
            for header in request.get("headers", [])
            if header.get("name", "").lower() in AUTH_HEADERS
        ]

        total = url_score + body_score
        if total <= 0:
            continue

        candidates.append(
            Candidate(
                url=url,
                method=request.get("method", "GET"),
                status=status,
                mime=mime,
                size=len(text),
                score=total,
                reasons=reasons + body_reasons,
                auth_headers=auth,
                body=body,
                query={
                    q.get("name", ""): q.get("value", "")
                    for q in request.get("queryString", [])
                },
                post_data=(request.get("postData", {}) or {}).get("text", "")[:2000],
            )
        )

    candidates.sort(key=lambda c: c.score, reverse=True)
    return candidates


def report(candidates: list[Candidate], top: int = 5, verbose: bool = False) -> str:
    """Human-readable ranking. Credentials are named, never shown."""
    if not candidates:
        return (
            "No plausible odds endpoint found.\n\n"
            "Most likely causes:\n"
            "  - the HAR was saved without response bodies. Use "
            '"Save all as HAR with content".\n'
            "  - the board had already loaded, so nothing was re-fetched. Tick "
            '"Preserve log", then hard-refresh (Ctrl-Shift-R) with DevTools open.\n'
            "  - the board is server-rendered HTML with no separate odds call. "
            "Look for the .aspx/.php document request itself and use parse='html'."
        )

    out = [f"Found {len(candidates)} candidate request(s). Best matches:\n"]
    for rank, c in enumerate(candidates[:top], start=1):
        out.append(f"{rank}. [score {c.score:.0f}] {c.method} {c.path}")
        out.append(f"     status {c.status}  {c.mime or 'unknown type'}  {c.size:,} bytes")
        for reason in c.reasons[:4]:
            out.append(f"     - {reason}")
        if c.query:
            keys = ", ".join(list(c.query)[:8])
            out.append(f"     query params: {keys}")
        if c.auth_headers:
            out.append(
                f"     auth carried in: {', '.join(c.auth_headers)} "
                "(value redacted -- put it in an env var, never in config)"
            )
        else:
            out.append("     no auth header seen; session may ride on a plain cookie")
        if verbose and c.body is not None:
            out.append("     payload shape:")
            for path, kind, example in shape(c.body, max_paths=25):
                sample = str(example)[:40]
                out.append(f"       {path:<46} {kind:<6} {sample}")
        out.append("")

    out.append(
        "Next: run `evscan discover <file.har> --emit-config --pick 1` to draft the\n"
        "[book.http] block, then map the payload fields to columns with --verbose."
    )
    return "\n".join(out)


def draft_config(candidate: Candidate) -> str:
    """Emit a starter [book.http] block for the chosen endpoint.

    Field paths are guessed from the payload shape and will need your eye --
    this gets the plumbing right so you only have to fix names.
    """
    parsed = urlparse(candidate.url)
    endpoint = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"

    lines = [
        "# Drafted by `evscan discover`. Review before trusting it.",
        "# The auth value goes in the environment, never in this file:",
        "#     export BOOK_AUTH='<paste the cookie/token here>'",
        "",
        "[book.http]",
        f'enabled = true',
        f'url = "{endpoint}"',
        f'method = "{candidate.method}"',
        f'parse = "{"json" if candidate.is_json else "html"}"',
    ]

    if candidate.query:
        lines.append("")
        lines.append("[book.http.params]")
        for key, value in candidate.query.items():
            lines.append(f'{key} = "{value}"')

    lines.append("")
    lines.append("[book.http.headers]")
    if candidate.auth_headers:
        for header in candidate.auth_headers:
            lines.append(f'{header} = "${{BOOK_AUTH}}"')
    else:
        lines.append('Cookie = "${BOOK_AUTH}"')
    lines.append('Accept = "application/json, text/plain, */*"')

    lines.append("")
    lines.append("# Map the payload onto line fields. Paths support [*] wildcards;")
    lines.append("# run `evscan discover <har> --verbose` to see the real shape.")
    lines.append("[book.http.mapping]")

    guesses = _guess_mapping(candidate)
    for field_name, path in guesses.items():
        marker = "" if path else "   # <- fill this in"
        lines.append(f'{field_name} = "{path}"{marker}')
    return "\n".join(lines) + "\n"


def _guess_mapping(candidate: Candidate) -> dict[str, str]:
    """Best-effort field mapping from the payload's own key names.

    Betting payloads nest: a game carries the team names, and the prices sit
    in an array inside it. So the mapping has two loops -- `groups` (games)
    and `rows` (the prices within one) -- and a field is resolved against the
    row first, then the group, then the document root.
    """
    aliases = {
        "away_team": ["awayteam", "away", "visitor", "visitorteam", "team2"],
        "home_team": ["hometeam", "home", "team1"],
        "market": ["wagertype", "bettype", "markettype", "wager", "market", "type"],
        "selection": ["selection", "teamname", "team", "side", "pick", "name"],
        "point": ["spread", "handicap", "line", "total", "number", "point"],
        "american": ["price", "odds", "moneyline", "juice", "american", "amount"],
        "commence_time": [
            "gamedatetime", "gamedate", "gametime", "starttime", "startdate",
            "eventdate", "date", "start",
        ],
    }
    empty = {"groups": "", "rows": "", **{k: "" for k in aliases}}
    if candidate.body is None:
        return empty

    paths = [p for p, _kind, _v in shape(candidate.body, max_paths=300)]
    array_prefixes: dict[str, int] = {}
    for path in paths:
        if "[*]" in path:
            prefix = path.rsplit("[*]", 1)[0] + "[*]"
            array_prefixes[prefix] = array_prefixes.get(prefix, 0) + 1
    if not array_prefixes:
        return empty

    # The row container is the array holding the most leaves.
    rows_abs = max(array_prefixes, key=lambda k: (array_prefixes[k], len(k)))
    # The group container is the deepest array strictly containing the rows.
    parents = [
        prefix for prefix in array_prefixes
        if prefix != rows_abs and rows_abs.startswith(prefix)
    ]
    groups_abs = max(parents, key=len) if parents else ""

    def relative(path: str) -> str:
        for scope in (rows_abs, groups_abs):
            if scope and path.startswith(scope):
                return path[len(scope):].lstrip(".")
        return path

    def find(candidates: list[str]) -> str:
        """Exact leaf match first; fall back to substring before giving up."""
        for exact in (True, False):
            for path in paths:
                leaf = path.split(".")[-1].replace("[*]", "").lower()
                leaf = leaf.replace("_", "").replace("-", "")
                for alias in candidates:
                    target = alias.replace("_", "")
                    if (leaf == target) if exact else (target in leaf):
                        return relative(path)
        return ""

    mapping = {
        "groups": groups_abs,
        "rows": rows_abs[len(groups_abs):].lstrip(".") if groups_abs else rows_abs,
    }
    for field_name, candidates in aliases.items():
        mapping[field_name] = find(candidates)
    return mapping
