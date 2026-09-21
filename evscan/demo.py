"""Synthetic market, so the dashboard can be seen before any data is wired.

`evscan serve --demo` runs the real engine -- real de-vigging, real EV, real
Kelly -- against a simulated market whose sharp books drift over time while
the private book's numbers lag behind. That lag is exactly the situation the
dashboard exists to catch, so the demo shows the product working rather than
a screenshot of it.

Nothing here is used by a live scan.
"""

from __future__ import annotations

import math
import random
import time
from datetime import datetime, timedelta, timezone

from .models import BookLine, Event, Outcome, Quote
from .oddsmath import american_to_prob, prob_to_american

GAMES = [
    ("americanfootball_nfl", "Buffalo Bills", "Kansas City Chiefs", 0.455, 47.5, 3.5),
    ("americanfootball_nfl", "Detroit Lions", "Green Bay Packers", 0.520, 51.5, -1.5),
    ("basketball_nba", "Boston Celtics", "Denver Nuggets", 0.480, 228.5, 2.5),
    ("basketball_nba", "New York Knicks", "Milwaukee Bucks", 0.435, 224.5, 4.5),
    ("icehockey_nhl", "Colorado Avalanche", "Dallas Stars", 0.505, 6.5, -1.5),
]

SHARP_BOOKS = (("pinnacle", 0.022), ("betonlineag", 0.030), ("circasports", 0.026))
RETAIL_BOOKS = (("draftkings", 0.045), ("fanduel", 0.046), ("betmgm", 0.052))


def _priced(prob: float, margin: float) -> tuple[float, float]:
    """A two-way market at `prob`, with `margin` of vig added to each side."""
    scale = 1.0 + margin
    return prob_to_american(prob * scale), prob_to_american((1.0 - prob) * scale)


def _drift(base: float, period: float, amplitude: float, phase: float) -> float:
    """A slow sine wave so the sharp market visibly moves between refreshes."""
    return base + amplitude * math.sin(time.time() / period + phase)


def build_market(seed: int | None = None) -> tuple[list[Event], list[BookLine]]:
    """A moving sharp market, and a private book that updates more slowly."""
    rng = random.Random(seed if seed is not None else int(time.time() // 300))
    now = datetime.now(timezone.utc)
    events: list[Event] = []
    lines: list[BookLine] = []

    for index, (sport, away, home, base_prob, total, spread) in enumerate(GAMES):
        commence = now + timedelta(hours=3 + index * 5)
        event = Event(f"demo-{index}", sport, commence, home, away)

        # The sharp consensus moves continuously.
        true_prob = _drift(base_prob, period=70.0, amplitude=0.045, phase=index)

        for book, margin in SHARP_BOOKS + RETAIL_BOOKS:
            noise = rng.uniform(-0.004, 0.004)
            away_price, home_price = _priced(true_prob + noise, margin)
            event.quotes.append(Quote(book, "h2h", (
                Outcome(away, round(away_price)), Outcome(home, round(home_price)),
            )))
            over, under = _priced(0.5 + noise, margin)
            event.quotes.append(Quote(book, "totals", (
                Outcome("Over", round(over), total), Outcome("Under", round(under), total),
            )))
            fav, dog = _priced(0.5 - noise, margin)
            event.quotes.append(Quote(book, "spreads", (
                Outcome(away, round(fav), spread), Outcome(home, round(dog), -spread),
            )))
        events.append(event)

        # The private book is slow: it prices off where the market was a
        # while ago, which is what creates a catchable edge.
        lagged = _drift(base_prob, period=70.0, amplitude=0.045, phase=index - 2.1)
        stale_away, _ = _priced(lagged, 0.035)
        lines.append(BookLine(
            book="MSB247", sport=sport, away_team=away, home_team=home,
            market="h2h", selection=away, american=round(stale_away),
            commence_time=commence, max_stake=500.0, note="demo",
        ))
        if index % 2 == 0:
            lines.append(BookLine(
                book="MSB247", sport=sport, away_team=away, home_team=home,
                market="totals", selection="Over", point=total,
                american=round(_priced(_drift(0.5, 85.0, 0.035, index - 1.9), 0.035)[0]),
                commence_time=commence, max_stake=500.0, note="demo",
            ))
    return events, lines
