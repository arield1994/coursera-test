"""Building the dashboard payload, and serving it.

The page is static HTML reading a JSON file. This module produces that JSON
and runs a small server that regenerates it on a timer, because a file
refreshed by cron is far too slow to catch a line before it moves.

Everything the page needs is precomputed here -- formatted prices, ages,
movement sparklines, alert flags -- so the browser does no betting maths.
"""

from __future__ import annotations

import json
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone
from pathlib import Path

from .config import Config
from .models import Opportunity
from .movement import Age, History, Movement, selection_key
from .oddsmath import format_american
from .scan import ScanResult


def _starts_in(commence: datetime) -> str:
    delta = (commence - datetime.now(timezone.utc)).total_seconds()
    if delta < 0:
        return "live"
    if delta < 3600:
        return f"{int(delta // 60)}m"
    if delta < 86400:
        # Floor, don't round: 18h 59.6m must not render as "18h 60m".
        return f"{int(delta // 3600)}h {int((delta % 3600) // 60)}m"
    return f"{int(delta // 86400)}d {int((delta % 86400) // 3600)}h"


def staleness(sharp: Movement, book: Movement) -> float:
    """How far your book is lagging the sharp market, 0..1.

    The premise of the whole dashboard: a sharp move your book has not
    followed is a stale number, and stale numbers are the bets worth taking.
    A market where both moved together is merely a disagreement.
    """
    if not sharp.is_significant:
        return 0.0
    lag = abs(sharp.delta_prob) - abs(book.delta_prob)
    if lag <= 0:
        return 0.0
    return min(1.0, lag / 0.05)


def bet_url(config: Config, opp: Opportunity) -> str:
    """Deep link into your book's slip, if its URL pattern is configured."""
    template = config.book.bet_url_template
    if not template:
        return config.book.url
    try:
        return template.format(
            event_id=opp.event.event_id if opp.event else "",
            market=opp.line.market,
            selection=opp.line.selection,
            point="" if opp.line.point is None else opp.line.point,
            away=opp.line.away_team,
            home=opp.line.home_team,
        )
    except (KeyError, IndexError):
        # A malformed template should not break the dashboard.
        return config.book.url


def build_bet(
    opp: Opportunity,
    config: Config,
    history: History,
    reference_book: str = "pinnacle",
) -> dict:
    """One row of the dashboard, fully formatted."""
    event = opp.event
    event_id = event.event_id if event else ""
    key = selection_key(event_id, opp.line.market, opp.line.selection, opp.line.point)

    age: Age = history.touch_opportunity(key, opp.ev)
    window = config.dashboard.movement_window
    sharp = history.movement(
        event_id, opp.line.market, opp.line.selection.lower(), opp.line.point,
        book=reference_book, window_minutes=window,
    )
    book = history.movement(
        event_id, opp.line.market, opp.line.selection.lower(), opp.line.point,
        book=config.book.name.lower(), window_minutes=window,
    )
    series = history.series(
        event_id, opp.line.market, opp.line.selection.lower(), opp.line.point,
        book=reference_book, window_minutes=180.0,
    )

    warnings = []
    if age.staleness_warning:
        warnings.append(age.staleness_warning)
    if opp.confidence == "fragile":
        warnings.append("-EV under the least friendly book")
    elif opp.confidence == "thin":
        warnings.append("few books, or they disagree")

    return {
        "id": key,
        "matchup": event.label if event else f"{opp.line.away_team} @ {opp.line.home_team}",
        "commence_time": event.commence_time.isoformat() if event else "",
        "starts_in": _starts_in(event.commence_time) if event else "",
        "market": opp.line.market,
        "bet": opp.line.label,
        "your_price": format_american(opp.line.american),
        "fair_price": format_american(opp.fair.fair_american),
        "ev_pct": round(opp.ev_pct, 2),
        "ev_conservative_pct": round(opp.ev_conservative * 100, 2),
        "edge_cents": round(opp.edge_cents),
        "stake": round(opp.stake, 2),
        "kelly_pct": round(opp.kelly * 100, 2),
        "books": opp.fair.books_used,
        "book_count": len(opp.fair.books_used),
        "mean_hold_pct": round(opp.fair.mean_hold * 100, 2),
        "disagreement_pct": round(opp.fair.disagreement * 100, 2),
        "confidence": opp.confidence,
        "age_seconds": round(age.seconds),
        "age_label": age.label,
        "is_new": age.is_new,
        "best_ev_pct": round(age.best_ev * 100, 2),
        "stale_score": round(staleness(sharp, book), 3),
        "movement": {
            "direction": sharp.direction,
            "cents": round(sharp.delta_cents),
            "text": sharp.describe(),
            "significant": sharp.is_significant,
            "series": [round(price) for _ts, price in series],
        },
        "book_followed": abs(book.delta_prob) > 0.002,
        "url": bet_url(config, opp),
        "warnings": warnings,
        "alert": opp.ev >= config.dashboard.alert_min_ev and opp.confidence != "fragile",
    }


def build_payload(
    result: ScanResult,
    config: Config,
    history: History,
    quota: str = "",
    error: str = "",
) -> dict:
    """The complete JSON the page reads."""
    bets = [build_bet(opp, config, history) for opp in result.opportunities]
    # Freshest genuine stale lines first; they are the ones that vanish.
    bets.sort(key=lambda b: (b["stale_score"], b["ev_pct"]), reverse=True)

    return {
        "generated_at": time.time(),
        "generated_label": datetime.now().strftime("%H:%M:%S"),
        "refresh_seconds": config.dashboard.refresh_seconds,
        "poll_seconds": config.dashboard.poll_seconds,
        "alert_min_ev": config.dashboard.alert_min_ev * 100,
        "book_name": config.book.name,
        "bankroll": config.bankroll.amount,
        "lines_scanned": result.lines_scanned,
        "total_stake": round(result.total_stake, 2),
        "expected_profit": round(result.expected_profit, 2),
        "quota": quota,
        "error": error,
        "bets": bets,
        "unpriced": [
            {"line": f.line.label,
             "matchup": f"{f.line.away_team} @ {f.line.home_team}",
             "reason": f.reason}
            for f in result.failures[:25]
        ],
        "below_threshold": [
            {"line": line.label,
             "matchup": f"{line.away_team} @ {line.home_team}",
             "ev_pct": round(ev * 100, 2)}
            for line, ev in result.rejected[:15]
        ],
    }


def write_payload(payload: dict, path: str | Path) -> Path:
    """Write results.json atomically, so the page never reads a half file."""
    target = Path(path)
    temp = target.with_suffix(target.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    temp.replace(target)
    return target


class Refresher(threading.Thread):
    """Re-runs the scan on a timer and rewrites the JSON."""

    def __init__(self, scan_once, config: Config, on_error=None) -> None:
        super().__init__(daemon=True)
        self.scan_once = scan_once
        self.config = config
        self.on_error = on_error
        self.stop_event = threading.Event()
        self.last_payload: dict | None = None
        self.last_error = ""
        self.runs = 0

    def run(self) -> None:
        while not self.stop_event.is_set():
            started = time.monotonic()
            try:
                payload = self.scan_once()
                self.last_payload = payload
                self.last_error = ""
                self.runs += 1
            except Exception as exc:                # keep serving stale data
                self.last_error = f"{type(exc).__name__}: {exc}"
                if self.on_error:
                    self.on_error(exc)
            elapsed = time.monotonic() - started
            self.stop_event.wait(max(1.0, self.config.dashboard.refresh_seconds - elapsed))

    def stop(self) -> None:
        self.stop_event.set()


# ------------------------------------------------------------------ serving


class _Handler(BaseHTTPRequestHandler):
    """Serves exactly two files. Nothing else is reachable."""

    server_version = "evscan"
    refresher: "Refresher" = None
    output_path: Path = None

    def _send(self, body: bytes, content_type: str, cache: bool = False) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if not cache:
            self.send_header("Cache-Control", "no-store, must-revalidate")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass    # the tab was closed mid-response; harmless

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]

        if path in ("/", "/index.html"):
            page = Path(__file__).parent / "static" / "index.html"
            self._send(page.read_bytes(), "text/html; charset=utf-8")
            return

        if path == "/sniffer.js":
            script = Path(__file__).parent / "static" / "sniffer.js"
            self._send(script.read_bytes(), "text/javascript; charset=utf-8")
            return

        if path == "/results.json":
            payload = self.refresher.last_payload if self.refresher else None
            if payload is None and self.output_path and self.output_path.exists():
                self._send(self.output_path.read_bytes(), "application/json")
                return
            if payload is None:
                self._send(
                    json.dumps({
                        "generated_at": 0, "generated_label": "--", "bets": [],
                        "lines_scanned": 0, "total_stake": 0, "expected_profit": 0,
                        "error": "first scan has not finished yet",
                    }).encode(),
                    "application/json",
                )
                return
            if self.refresher and self.refresher.last_error:
                payload = dict(payload, error=self.refresher.last_error)
            self._send(json.dumps(payload).encode(), "application/json")
            return

        self.send_error(404, "evscan serves /, /results.json and /sniffer.js only")

    def log_message(self, fmt: str, *args) -> None:
        """Silence per-request logging; the page polls every few seconds."""


def serve(scan_once, config: Config, open_browser: bool = True) -> int:
    """Run the dashboard until interrupted."""
    dash = config.dashboard
    output = Path(dash.output)

    def refresh_and_write() -> dict:
        payload = scan_once()
        write_payload(payload, output)
        return payload

    refresher = Refresher(refresh_and_write, config)
    _Handler.refresher = refresher
    _Handler.output_path = output
    refresher.start()

    httpd = ThreadingHTTPServer((dash.host, dash.port), _Handler)
    url = f"http://{dash.host}:{dash.port}/"
    print(f"Edge board on {url}")
    print(f"  re-pricing every {dash.refresh_seconds:.0f}s, "
          f"page polls every {dash.poll_seconds:.0f}s")
    print(f"  writing {output}")
    print("  Ctrl-C to stop")

    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        refresher.stop()
        httpd.shutdown()
    return 0
