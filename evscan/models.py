"""Core data types shared by the sources, the engine, and the renderer."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from .oddsmath import american_to_decimal, american_to_prob, format_american


@dataclass(frozen=True)
class Outcome:
    """One side of a market at one book."""

    name: str                      # "Kansas City Chiefs", "Over", "Patrick Mahomes"
    american: float
    point: float | None = None     # spread or total line; None for moneylines

    @property
    def decimal(self) -> float:
        return american_to_decimal(self.american)

    @property
    def implied(self) -> float:
        """Implied probability, margin included."""
        return american_to_prob(self.american)

    @property
    def price_label(self) -> str:
        return format_american(self.american)

    def key(self) -> tuple[str, float | None]:
        """Identity of this outcome within a market, ignoring price."""
        return (self.name.strip().lower(), self.point)


@dataclass(frozen=True)
class Quote:
    """A complete market as posted by a single book."""

    book: str                      # "pinnacle"
    market: str                    # "h2h", "spreads", "totals"
    outcomes: tuple[Outcome, ...]
    last_update: datetime | None = None

    @property
    def implied(self) -> list[float]:
        return [o.implied for o in self.outcomes]

    @property
    def hold(self) -> float:
        total = sum(self.implied)
        return (total - 1.0) / total

    def is_complete(self, expected: int = 2) -> bool:
        """A market missing a side cannot be de-vigged."""
        return len(self.outcomes) >= expected

    def find(self, name: str, point: float | None = None) -> Outcome | None:
        target = name.strip().lower()
        for o in self.outcomes:
            if o.name.strip().lower() == target and o.point == point:
                return o
        return None


@dataclass
class Event:
    """A game, with every book's quotes attached."""

    event_id: str
    sport: str
    commence_time: datetime
    home_team: str
    away_team: str
    quotes: list[Quote] = field(default_factory=list)

    @property
    def label(self) -> str:
        return f"{self.away_team} @ {self.home_team}"

    @property
    def is_live(self) -> bool:
        return self.commence_time <= datetime.now(timezone.utc)

    def quotes_for(self, market: str) -> list[Quote]:
        return [q for q in self.quotes if q.market == market]

    def markets(self) -> list[str]:
        seen: list[str] = []
        for q in self.quotes:
            if q.market not in seen:
                seen.append(q.market)
        return seen


@dataclass(frozen=True)
class BookLine:
    """A price at *your* book -- the thing being evaluated.

    These do not come from the odds feed; MSB247 and other agent books are
    not in any public API. They are read from your lines CSV or typed
    straight into `evscan quote`.
    """

    book: str
    sport: str
    away_team: str
    home_team: str
    market: str
    selection: str
    american: float
    point: float | None = None
    commence_time: datetime | None = None
    max_stake: float | None = None   # your account's limit, if you track it
    note: str = ""

    @property
    def decimal(self) -> float:
        return american_to_decimal(self.american)

    @property
    def label(self) -> str:
        if self.point is None:
            return self.selection
        return f"{self.selection} {self.point:+g}" if self.market == "spreads" else f"{self.selection} {self.point:g}"


@dataclass
class FairPrice:
    """The market's consensus view of one selection, margin removed."""

    prob: float                    # weighted consensus fair probability
    prob_sharp: float              # sharpest single reference book, alone
    prob_low: float                # most pessimistic reference book
    prob_high: float
    books_used: list[str]
    method: str
    mean_hold: float

    @property
    def fair_american(self) -> float:
        from .oddsmath import prob_to_american
        return prob_to_american(self.prob)

    @property
    def disagreement(self) -> float:
        """Spread between the most and least optimistic reference book.

        Wide disagreement means the market has not settled and your 'edge'
        may just be noise between two books.
        """
        return self.prob_high - self.prob_low


@dataclass
class Opportunity:
    """A priced bet at your book, judged against the fair market."""

    line: BookLine
    fair: FairPrice
    event: Event | None
    ev: float                      # expected profit per unit staked
    kelly: float                   # full-Kelly fraction of bankroll
    stake: float                   # recommended stake after fraction + caps
    ev_conservative: float         # EV using the most pessimistic reference

    @property
    def ev_pct(self) -> float:
        return self.ev * 100.0

    @property
    def edge_cents(self) -> float:
        """How much better your price is than fair, in American-odds terms."""
        return self.line.american - self.fair.fair_american

    @property
    def confidence(self) -> str:
        """Rough triage flag, not a substitute for reading the numbers."""
        if self.ev_conservative <= 0:
            return "fragile"      # only +EV under the friendliest reference
        if len(self.fair.books_used) < 3 or self.fair.disagreement > 0.03:
            return "thin"         # few books, or they disagree
        return "solid"
