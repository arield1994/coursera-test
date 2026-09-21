"""Tracking how the sharp market moves, and whether your book has noticed.

The edge at a private book is rarely that its number is wrong in isolation.
It is that Pinnacle moved twenty minutes ago and your bookie has not caught
up. That gap is the bet, and it closes fast.

So this module keeps a rolling history of every sharp price it has seen and
answers three questions the dashboard needs:

    has the sharp market moved recently, and which way?
    has your book followed it, or is its number frozen?
    how long has this opportunity existed?

The last one matters more than it sounds. An edge that appeared eight
seconds ago is a stale line. The same edge sitting there for two hours is
usually a trap -- a limit you cannot reach, a player who is out, or a market
your book has deliberately priced away from the consensus.

Storage is SQLite so history survives restarts and stays queryable.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

from .models import Event

DEFAULT_DB = ".evscan-history.db"
HISTORY_LIMIT_DAYS = 7

SCHEMA = """
CREATE TABLE IF NOT EXISTS price_history (
    ts        REAL NOT NULL,
    event_id  TEXT NOT NULL,
    market    TEXT NOT NULL,
    selection TEXT NOT NULL,
    point     REAL,
    book      TEXT NOT NULL,
    american  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_lookup
    ON price_history (event_id, market, selection, point, ts);

CREATE TABLE IF NOT EXISTS opportunity_log (
    key        TEXT PRIMARY KEY,
    first_seen REAL NOT NULL,
    last_seen  REAL NOT NULL,
    first_ev   REAL NOT NULL,
    best_ev    REAL NOT NULL,
    last_ev    REAL NOT NULL
);
"""


@dataclass
class Movement:
    """How the sharp market has moved on one selection."""

    delta_prob: float        # change in fair probability over the window
    delta_cents: float       # same move expressed in American odds
    samples: int
    minutes: float
    opened_american: float | None = None
    latest_american: float | None = None

    @property
    def direction(self) -> str:
        if abs(self.delta_prob) < 0.002:
            return "flat"
        return "toward" if self.delta_prob > 0 else "away"

    @property
    def is_significant(self) -> bool:
        """A move big enough that a slow book not following it is the story."""
        return abs(self.delta_prob) >= 0.01 and self.samples >= 2

    def describe(self) -> str:
        if self.samples < 2:
            return "no movement data yet"
        if self.direction == "flat":
            return f"sharp line steady for {self.minutes:.0f}m"
        word = "shortened" if self.delta_prob > 0 else "drifted"
        return (
            f"sharp line {word} {abs(self.delta_cents):.0f} cents "
            f"in {self.minutes:.0f}m"
        )


@dataclass
class Age:
    """How long an opportunity has been visible."""

    first_seen: float
    last_seen: float
    first_ev: float
    best_ev: float
    seconds: float
    is_new: bool

    @property
    def label(self) -> str:
        if self.seconds < 60:
            return f"{self.seconds:.0f}s"
        if self.seconds < 3600:
            return f"{self.seconds / 60:.0f}m"
        return f"{self.seconds / 3600:.1f}h"

    @property
    def staleness_warning(self) -> str:
        """An old edge is usually not an edge."""
        if self.seconds > 7200:
            return "open >2h -- likely unreachable or priced deliberately"
        if self.seconds > 1800:
            return "open >30m -- check it is still live"
        return ""


def selection_key(event_id: str, market: str, selection: str, point: float | None) -> str:
    return f"{event_id}|{market}|{selection.lower()}|{'' if point is None else point}"


class History:
    """Rolling price history, backed by SQLite."""

    def __init__(self, path: str | Path = DEFAULT_DB) -> None:
        self.path = str(path)
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # ------------------------------------------------------------- recording

    def record(self, events: list[Event], books: set[str] | None = None) -> int:
        """Snapshot every sharp price in this batch. Returns rows written."""
        now = time.time()
        rows = []
        for event in events:
            for quote in event.quotes:
                if books is not None and quote.book not in books:
                    continue
                for outcome in quote.outcomes:
                    rows.append((
                        now, event.event_id, quote.market, outcome.name.lower(),
                        outcome.point, quote.book, outcome.american,
                    ))
        if rows:
            self.conn.executemany(
                "INSERT INTO price_history "
                "(ts, event_id, market, selection, point, book, american) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            self.conn.commit()
        return len(rows)

    def record_book_lines(self, matched, book_name: str) -> int:
        """Snapshot your own book's prices, so lag against the sharps is visible.

        Without this the dashboard can see that the market moved but not
        whether your book followed -- which is the entire distinction between
        a stale line and an ordinary disagreement.
        """
        now = time.time()
        rows = [
            (now, event.event_id, line.market, line.selection.lower(),
             line.point, book_name.lower(), line.american)
            for line, event in matched
        ]
        if rows:
            self.conn.executemany(
                "INSERT INTO price_history "
                "(ts, event_id, market, selection, point, book, american) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            self.conn.commit()
        return len(rows)

    def prune(self, days: int = HISTORY_LIMIT_DAYS) -> int:
        cutoff = time.time() - days * 86400
        cursor = self.conn.execute(
            "DELETE FROM price_history WHERE ts < ?", (cutoff,)
        )
        self.conn.commit()
        return cursor.rowcount

    # -------------------------------------------------------------- movement

    def movement(
        self,
        event_id: str,
        market: str,
        selection: str,
        point: float | None,
        book: str = "pinnacle",
        window_minutes: float = 60.0,
    ) -> Movement:
        """How one book's price on this selection has moved over the window."""
        since = time.time() - window_minutes * 60.0
        if point is None:
            where, params = "point IS NULL", (event_id, market, selection.lower(), book, since)
        else:
            where, params = "ABS(point - ?) < 1e-9", (
                event_id, market, selection.lower(), book, since, point
            )
            params = (event_id, market, selection.lower(), book, since, point)

        query = (
            "SELECT ts, american FROM price_history "
            "WHERE event_id = ? AND market = ? AND selection = ? AND book = ? "
            f"AND ts >= ? AND {where} ORDER BY ts ASC"
        )
        rows = self.conn.execute(query, params).fetchall()
        if len(rows) < 2:
            latest = rows[-1][1] if rows else None
            return Movement(0.0, 0.0, len(rows), 0.0, latest, latest)

        from .oddsmath import american_to_prob

        opened, latest = rows[0][1], rows[-1][1]
        try:
            delta_prob = american_to_prob(latest) - american_to_prob(opened)
        except Exception:
            delta_prob = 0.0
        return Movement(
            delta_prob=delta_prob,
            delta_cents=latest - opened,
            samples=len(rows),
            minutes=(rows[-1][0] - rows[0][0]) / 60.0,
            opened_american=opened,
            latest_american=latest,
        )

    def series(
        self,
        event_id: str,
        market: str,
        selection: str,
        point: float | None,
        book: str = "pinnacle",
        window_minutes: float = 180.0,
        max_points: int = 40,
    ) -> list[tuple[float, float]]:
        """(timestamp, american) points for a sparkline."""
        since = time.time() - window_minutes * 60.0
        if point is None:
            where = "point IS NULL"
            params = (event_id, market, selection.lower(), book, since)
        else:
            where = "ABS(point - ?) < 1e-9"
            params = (event_id, market, selection.lower(), book, since, point)
        rows = self.conn.execute(
            "SELECT ts, american FROM price_history "
            "WHERE event_id = ? AND market = ? AND selection = ? AND book = ? "
            f"AND ts >= ? AND {where} ORDER BY ts ASC",
            params,
        ).fetchall()
        if len(rows) <= max_points:
            return [(r[0], r[1]) for r in rows]
        step = len(rows) / max_points
        return [rows[int(i * step)] for i in range(max_points)]

    # ------------------------------------------------------------------- age

    def touch_opportunity(self, key: str, ev: float) -> Age:
        """Record that this edge is visible now; return how long it has been."""
        now = time.time()
        row = self.conn.execute(
            "SELECT first_seen, last_seen, first_ev, best_ev FROM opportunity_log "
            "WHERE key = ?",
            (key,),
        ).fetchone()

        if row is None:
            self.conn.execute(
                "INSERT INTO opportunity_log "
                "(key, first_seen, last_seen, first_ev, best_ev, last_ev) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (key, now, now, ev, ev, ev),
            )
            self.conn.commit()
            return Age(now, now, ev, ev, 0.0, True)

        first_seen, last_seen, first_ev, best_ev = row
        # A gap longer than ten minutes means the edge disappeared and came
        # back -- that is a new opportunity, not an old one.
        if now - last_seen > 600:
            self.conn.execute(
                "UPDATE opportunity_log SET first_seen = ?, last_seen = ?, "
                "first_ev = ?, best_ev = ?, last_ev = ? WHERE key = ?",
                (now, now, ev, ev, ev, key),
            )
            self.conn.commit()
            return Age(now, now, ev, ev, 0.0, True)

        best_ev = max(best_ev, ev)
        self.conn.execute(
            "UPDATE opportunity_log SET last_seen = ?, best_ev = ?, last_ev = ? "
            "WHERE key = ?",
            (now, best_ev, ev, key),
        )
        self.conn.commit()
        return Age(
            first_seen, now, first_ev, best_ev,
            seconds=now - first_seen,
            is_new=(now - first_seen) < 90,
        )
