"""Client for the-odds-api.com.

Free tier is 500 credits/month, and a credit is charged per region per
market -- so `regions=us,us2,eu` with `markets=h2h,spreads` costs 6 credits
per call, not 1. The client reports remaining quota after every request and
caches responses to disk so that re-running a scan costs nothing.

Stdlib only: urllib honours HTTPS_PROXY and SSL_CERT_FILE from the
environment, which matters in sandboxed runners.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..models import Event, Outcome, Quote

BASE_URL = "https://api.the-odds-api.com/v4"
USER_AGENT = "evscan/0.1 (+https://github.com/arield1994/coursera-test)"


class OddsAPIError(RuntimeError):
    """Raised when the odds feed cannot be read."""


@dataclass
class Quota:
    """Credit accounting returned in the response headers."""

    remaining: int | None = None
    used: int | None = None
    last_cost: int | None = None

    def describe(self) -> str:
        if self.remaining is None:
            return "quota unknown"
        cost = f", last call cost {self.last_cost}" if self.last_cost else ""
        return f"{self.remaining} credits left (used {self.used}{cost})"


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class TheOddsAPI:
    """Fetches events and odds, with an on-disk cache to protect your quota."""

    def __init__(
        self,
        api_key: str,
        cache_dir: str | Path = ".evscan-cache",
        cache_ttl: float = 300.0,
        timeout: float = 20.0,
    ) -> None:
        if not api_key:
            raise OddsAPIError(
                "no API key. Set ODDS_API_KEY in your environment "
                "(free key at https://the-odds-api.com)."
            )
        self.api_key = api_key
        self.cache_dir = Path(cache_dir)
        self.cache_ttl = cache_ttl
        self.timeout = timeout
        self.quota = Quota()

    # ---------------------------------------------------------------- http

    def _cache_path(self, path: str, params: dict[str, str]) -> Path:
        safe = path.strip("/").replace("/", "_")
        stamp = urllib.parse.urlencode(sorted(params.items()))
        digest = str(abs(hash(stamp)) % (10**12))
        return self.cache_dir / f"{safe}.{digest}.json"

    def _get(
        self, path: str, params: dict[str, str], use_cache: bool = True
    ) -> list | dict:
        cache_file = self._cache_path(path, params)
        if use_cache and cache_file.exists():
            age = time.time() - cache_file.stat().st_mtime
            if age < self.cache_ttl:
                self.quota.last_cost = 0
                return json.loads(cache_file.read_text())

        query = dict(params)
        query["apiKey"] = self.api_key
        url = f"{BASE_URL}{path}?{urllib.parse.urlencode(query)}"
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
                headers = response.headers
                self.quota = Quota(
                    remaining=_as_int(headers.get("x-requests-remaining")),
                    used=_as_int(headers.get("x-requests-used")),
                    last_cost=_as_int(headers.get("x-requests-last")),
                )
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")[:400]
            if exc.code == 401:
                raise OddsAPIError(f"API key rejected (401): {body}") from exc
            if exc.code == 422:
                raise OddsAPIError(
                    f"the feed rejected these parameters (422): {body}"
                ) from exc
            if exc.code == 429:
                raise OddsAPIError(
                    f"out of credits or rate limited (429): {body}"
                ) from exc
            raise OddsAPIError(f"odds feed returned HTTP {exc.code}: {body}") from exc
        except urllib.error.URLError as exc:
            raise OddsAPIError(f"could not reach the odds feed: {exc.reason}") from exc

        self.cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(payload))
        return payload

    # ------------------------------------------------------------- queries

    def sports(self, all_sports: bool = False) -> list[dict]:
        """List sports with markets currently posted."""
        params = {"all": "true"} if all_sports else {}
        payload = self._get("/sports", params)
        if not isinstance(payload, list):
            raise OddsAPIError("unexpected payload from /sports")
        return payload

    def odds(
        self,
        sport: str,
        markets: str = "h2h,spreads,totals",
        regions: str = "us,us2,eu",
        odds_format: str = "american",
        use_cache: bool = True,
    ) -> list[Event]:
        """Fetch every book's prices for one sport."""
        params = {
            "regions": regions,
            "markets": markets,
            "oddsFormat": odds_format,
            "dateFormat": "iso",
        }
        payload = self._get(f"/sports/{sport}/odds", params, use_cache=use_cache)
        if not isinstance(payload, list):
            raise OddsAPIError(f"unexpected payload for {sport}")
        return [self._to_event(raw, sport) for raw in payload]

    # -------------------------------------------------------------- mapping

    @staticmethod
    def _to_event(raw: dict, sport: str) -> Event:
        commence = _parse_time(raw.get("commence_time")) or datetime.now(timezone.utc)
        event = Event(
            event_id=raw.get("id", ""),
            sport=raw.get("sport_key", sport),
            commence_time=commence,
            home_team=raw.get("home_team", ""),
            away_team=raw.get("away_team", ""),
        )
        for book in raw.get("bookmakers", []):
            book_key = book.get("key", "")
            updated = _parse_time(book.get("last_update"))
            for market in book.get("markets", []):
                outcomes = tuple(
                    Outcome(
                        name=o.get("name", ""),
                        american=float(o["price"]),
                        point=(
                            float(o["point"]) if o.get("point") is not None else None
                        ),
                    )
                    for o in market.get("outcomes", [])
                    if o.get("price") is not None
                )
                if not outcomes:
                    continue
                event.quotes.append(
                    Quote(
                        book=book_key,
                        market=market.get("key", ""),
                        outcomes=outcomes,
                        last_update=_parse_time(market.get("last_update")) or updated,
                    )
                )
        return event


def _as_int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
