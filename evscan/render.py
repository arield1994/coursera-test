"""Terminal output.

Plain text, aligned columns, no dependencies. Colour is used only to rank
urgency and switches off automatically when output is piped.
"""

from __future__ import annotations

import os
import sys

from .models import Opportunity
from .oddsmath import format_american
from .scan import ScanResult

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
CYAN = "\033[36m"


def use_colour(stream=sys.stdout) -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    return hasattr(stream, "isatty") and stream.isatty()


class Style:
    """Colour that quietly disappears when piped to a file."""

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    def __call__(self, text: str, *codes: str) -> str:
        if not self.enabled or not codes:
            return text
        return f"{''.join(codes)}{text}{RESET}"


def _ev_colour(ev: float) -> str:
    if ev >= 0.04:
        return GREEN
    if ev >= 0.02:
        return YELLOW
    return ""


CONFIDENCE_NOTE = {
    "solid": "",
    "thin": "few books / they disagree",
    "fragile": "-EV under the least friendly book",
}


def render_table(result: ScanResult, style: Style, bankroll: float) -> str:
    """The main table: every line worth betting, best edge first."""
    if not result.opportunities:
        return ""

    headers = ("MATCHUP", "BET", "YOURS", "FAIR", "EV", "STAKE", "BOOKS", "FLAG")
    widths = [38, 26, 7, 7, 8, 8, 6, 10]

    rows: list[list[str]] = []
    for opp in result.opportunities:
        event = opp.event
        matchup = event.label if event else f"{opp.line.away_team} @ {opp.line.home_team}"
        when = f" {event.commence_time:%a %H:%M}" if event else ""
        rows.append([
            (matchup[: widths[0] - len(when) - 1] + when),
            opp.line.label,
            format_american(opp.line.american),
            format_american(opp.fair.fair_american),
            f"{opp.ev_pct:+.2f}%",
            f"{opp.stake:,.0f}",
            str(len(opp.fair.books_used)),
            opp.confidence,
        ])

    for index, header in enumerate(headers):
        widths[index] = max(widths[index], len(header), *(len(r[index]) for r in rows))

    out = [style("  ".join(h.ljust(w) for h, w in zip(headers, widths)), BOLD)]
    out.append(style("  ".join("-" * w for w in widths), DIM))

    for opp, row in zip(result.opportunities, rows):
        cells = [cell.ljust(width) for cell, width in zip(row, widths)]
        cells[4] = style(cells[4], BOLD, _ev_colour(opp.ev))
        if opp.confidence != "solid":
            cells[7] = style(cells[7], YELLOW if opp.confidence == "thin" else RED)
        out.append("  ".join(cells))
    return "\n".join(out)


def render_detail(opp: Opportunity, style: Style) -> str:
    """Everything behind one recommendation, for when you want to check it."""
    fair = opp.fair
    event = opp.event
    lines = [
        style(f"{event.label if event else opp.line.label}", BOLD),
        f"  bet          {opp.line.label} at {format_american(opp.line.american)} ({opp.line.book})",
        f"  fair price   {format_american(fair.fair_american)}  "
        f"(p = {fair.prob:.4f}, {fair.method} de-vig)",
        f"  edge         {opp.ev_pct:+.2f}% EV, {opp.edge_cents:+.0f} cents of line value",
        f"  worst case   {opp.ev_conservative * 100:+.2f}% EV against the least friendly book",
        f"  market       {len(fair.books_used)} books: {', '.join(fair.books_used)}",
        f"  agreement    fair p ranges {fair.prob_low:.4f}-{fair.prob_high:.4f} "
        f"({fair.disagreement:.2%} spread), mean hold {fair.mean_hold:.2%}",
        f"  stake        {opp.stake:,.2f} "
        f"(full Kelly {opp.kelly:.2%} of bankroll, scaled and capped)",
    ]
    note = CONFIDENCE_NOTE.get(opp.confidence, "")
    if note:
        lines.append(style(f"  caution      {note}", YELLOW))
    return "\n".join(lines)


def render_summary(result: ScanResult, style: Style, quota: str = "") -> str:
    """Counts, money, and -- importantly -- what could not be priced."""
    out = [""]
    found = len(result.opportunities)
    if found:
        out.append(
            f"{found} of {result.lines_scanned} lines cleared the threshold. "
            f"Total stake {result.total_stake:,.2f}, "
            f"expected profit {result.expected_profit:+,.2f}."
        )
    else:
        out.append(
            f"No +EV lines out of {result.lines_scanned} scanned. "
            "That is the normal result most of the time."
        )

    if result.rejected:
        best = result.rejected[0]
        out.append(
            style(
                f"{len(result.rejected)} priced but below threshold "
                f"(best: {best[0].label} at {best[1] * 100:+.2f}%).",
                DIM,
            )
        )
    if result.failures:
        out.append(
            style(f"{len(result.failures)} line(s) could not be priced:", YELLOW)
        )
        for failure in result.failures[:8]:
            out.append(style(f"  - {failure.describe()}", DIM))
        if len(result.failures) > 8:
            out.append(style(f"  ... and {len(result.failures) - 8} more (--verbose)", DIM))
    if quota:
        out.append(style(f"odds feed: {quota}", DIM))
    return "\n".join(out)


def render_csv(result: ScanResult) -> str:
    """Machine-readable output for logging your bets and closing-line value."""
    import csv
    import io

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([
        "matchup", "commence_time", "market", "selection", "point",
        "your_price", "fair_price", "fair_prob", "ev_pct", "ev_conservative_pct",
        "kelly_pct", "stake", "books", "mean_hold", "confidence",
    ])
    for opp in result.opportunities:
        event = opp.event
        writer.writerow([
            event.label if event else "",
            event.commence_time.isoformat() if event else "",
            opp.line.market,
            opp.line.selection,
            "" if opp.line.point is None else opp.line.point,
            f"{opp.line.american:+.0f}",
            f"{opp.fair.fair_american:+.0f}",
            f"{opp.fair.prob:.6f}",
            f"{opp.ev_pct:.3f}",
            f"{opp.ev_conservative * 100:.3f}",
            f"{opp.kelly * 100:.3f}",
            f"{opp.stake:.2f}",
            "|".join(opp.fair.books_used),
            f"{opp.fair.mean_hold:.5f}",
            opp.confidence,
        ])
    return buffer.getvalue()
