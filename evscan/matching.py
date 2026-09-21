"""Matching your book's lines to the odds feed.

Your board writes "KC Chiefs" or just "Chiefs"; the feed says "Kansas City
Chiefs". A mismatch here silently drops a bet, and -- worse -- a *wrong*
match prices your bet against the wrong game. So the matcher is strict about
what it accepts and explicit about what it rejects.

Strategy, cheapest first:
  1. exact match on the normalized string
  2. one name contains the other ("chiefs" in "kansas city chiefs")
  3. shared distinctive token (the nickname: "chiefs", "bills")
  4. difflib similarity above a threshold
A match is only returned if it beats the runner-up clearly; two teams that
score alike (Jets/Nets, NY Giants/SF Giants) produce no match rather than a
coin flip.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import timedelta
from difflib import SequenceMatcher

from .models import BookLine, Event, Outcome, Quote

# Words that carry no identifying information in a team name.
NOISE = {
    "fc", "afc", "cf", "sc", "ac", "the", "university", "univ", "of", "st",
    "state", "college",
}

# Common shorthand a board uses that shares no token with the full name.
CITY_ABBREV = {
    "kc": "kansas city", "ny": "new york", "nyc": "new york", "la": "los angeles",
    "sf": "san francisco", "sd": "san diego", "tb": "tampa bay", "gb": "green bay",
    "ne": "new england", "no": "new orleans", "lv": "las vegas", "jax": "jacksonville",
    "phi": "philadelphia", "pit": "pittsburgh", "cin": "cincinnati", "cle": "cleveland",
    "bal": "baltimore", "buf": "buffalo", "mia": "miami", "hou": "houston",
    "ind": "indianapolis", "ten": "tennessee", "den": "denver", "sea": "seattle",
    "ari": "arizona", "atl": "atlanta", "car": "carolina", "chi": "chicago",
    "dal": "dallas", "det": "detroit", "min": "minnesota", "was": "washington",
    "wsh": "washington", "bos": "boston", "bkn": "brooklyn", "gsw": "golden state",
    "phx": "phoenix", "por": "portland", "sac": "sacramento", "uta": "utah",
    "mil": "milwaukee", "mem": "memphis", "nop": "new orleans", "okc": "oklahoma city",
}

MATCH_THRESHOLD = 0.72      # minimum similarity to accept a name match
MARGIN_THRESHOLD = 0.08     # winner must beat runner-up by this much
TIME_WINDOW = timedelta(hours=18)   # how far apart two "same" games may start

OVER_WORDS = {"over", "o", "ov"}
UNDER_WORDS = {"under", "u", "un"}


@dataclass
class MatchFailure:
    """Why a line could not be priced. Surfaced to the user, never silent."""

    line: BookLine
    reason: str

    def describe(self) -> str:
        return f"{self.line.away_team} @ {self.line.home_team} / {self.line.label}: {self.reason}"


def normalize(name: str) -> str:
    """Lowercase, strip accents and punctuation, expand city shorthand."""
    text = unicodedata.normalize("NFKD", name)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^a-z0-9 ]+", " ", text.lower())
    tokens = [t for t in text.split() if t and t not in NOISE]
    tokens = [CITY_ABBREV.get(t, t) for t in tokens]
    return " ".join(" ".join(tokens).split())


def tokens(name: str) -> set[str]:
    return set(normalize(name).split())


def similarity(a: str, b: str) -> float:
    """0..1 score for two team names referring to the same team."""
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0

    ta, tb = set(na.split()), set(nb.split())
    shared = ta & tb
    if shared:
        # A shared *last* token is the nickname and is highly distinctive.
        nickname_match = na.split()[-1] == nb.split()[-1]
        coverage = len(shared) / min(len(ta), len(tb))
        if nickname_match:
            return min(1.0, 0.88 + 0.12 * coverage)
        if coverage == 1.0:
            return 0.90
        base = 0.60 + 0.25 * coverage
        return max(base, SequenceMatcher(None, na, nb).ratio())

    if na in nb or nb in na:
        return 0.85
    return SequenceMatcher(None, na, nb).ratio()


def _best(name: str, candidates: list[str]) -> tuple[int, float] | None:
    """Index of the best candidate, if it wins clearly."""
    if not candidates:
        return None
    scored = sorted(
        ((similarity(name, c), i) for i, c in enumerate(candidates)), reverse=True
    )
    best_score, best_index = scored[0]
    if best_score < MATCH_THRESHOLD:
        return None
    if len(scored) > 1 and best_score - scored[1][0] < MARGIN_THRESHOLD:
        return None  # ambiguous: refuse rather than guess
    return best_index, best_score


def match_event(line: BookLine, events: list[Event]) -> tuple[Event | None, str]:
    """Find the feed event for a line. Returns (event, reason_if_none)."""
    pool = [e for e in events if not line.sport or e.sport == line.sport]
    if not pool:
        pool = list(events)
    if not pool:
        return None, "no events in the feed for this sport"

    if line.commence_time is not None:
        timed = [
            e for e in pool
            if abs(e.commence_time - line.commence_time) <= TIME_WINDOW
        ]
        if timed:
            pool = timed

    scored: list[tuple[float, Event]] = []
    for event in pool:
        home = similarity(line.home_team, event.home_team)
        away = similarity(line.away_team, event.away_team)
        straight = (home + away) / 2.0
        # Tolerate a board that lists home team first.
        flipped = (
            similarity(line.home_team, event.away_team)
            + similarity(line.away_team, event.home_team)
        ) / 2.0
        scored.append((max(straight, flipped), event))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    best_score, best_event = scored[0]
    if best_score < MATCH_THRESHOLD:
        return None, (
            f"no game in the feed matches (closest: {best_event.label} "
            f"at {best_score:.0%})"
        )
    if len(scored) > 1 and best_score - scored[1][0] < MARGIN_THRESHOLD:
        return None, (
            f"ambiguous: {best_event.label} and {scored[1][1].label} both match"
        )
    return best_event, ""


def resolve_selection(line: BookLine, event: Event) -> tuple[str, str]:
    """Map the line's selection onto the feed's naming. Returns (name, reason)."""
    if line.market == "totals":
        word = normalize(line.selection)
        if word in OVER_WORDS:
            return "Over", ""
        if word in UNDER_WORDS:
            return "Under", ""
        return "", f"totals selection must be Over or Under, got {line.selection!r}"

    index = _best(line.selection, [event.home_team, event.away_team])
    if index is None:
        return "", (
            f"selection {line.selection!r} matches neither "
            f"{event.away_team!r} nor {event.home_team!r}"
        )
    return (event.home_team, "") if index[0] == 0 else (event.away_team, "")


def find_outcome(quote: Quote, name: str, point: float | None) -> Outcome | None:
    """Locate the feed outcome corresponding to a selection and number.

    Point must match exactly. A -3.5 at your book and a -3 in the market are
    different bets, and pricing one against the other invents edge that is
    not there.
    """
    target = normalize(name)
    for outcome in quote.outcomes:
        if normalize(outcome.name) != target:
            continue
        if point is None or outcome.point is None:
            if point is None and outcome.point is None:
                return outcome
            continue
        if abs(outcome.point - point) < 1e-9:
            return outcome
    return None


def opposite_point(market: str, point: float | None) -> float | None:
    """The other side's number: spreads negate, totals share."""
    if point is None:
        return None
    return -point if market == "spreads" else point
