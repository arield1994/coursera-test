"""The scan: price every line on your board against the market."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from .config import Config
from .fairvalue import NoMarketError, fair_price
from .matching import MatchFailure, match_event, resolve_selection
from .models import BookLine, Event, Opportunity
from .oddsmath import ev_per_unit, kelly_fraction


@dataclass
class ScanResult:
    """Everything the scan learned, including what it could not price."""

    opportunities: list[Opportunity] = field(default_factory=list)
    failures: list[MatchFailure] = field(default_factory=list)
    rejected: list[tuple[BookLine, float]] = field(default_factory=list)
    lines_scanned: int = 0

    @property
    def total_stake(self) -> float:
        return sum(o.stake for o in self.opportunities)

    @property
    def expected_profit(self) -> float:
        return sum(o.stake * o.ev for o in self.opportunities)


def stake_for(kelly: float, line: BookLine, config: Config) -> float:
    """Kelly, scaled down and capped. Never the full Kelly number.

    Full Kelly assumes your probability estimate is exactly right. It never
    is, and being wrong at full Kelly is how bankrolls die -- so the default
    is a quarter, hard-capped at a small share of bankroll, and further
    capped by whatever your account actually accepts.
    """
    bankroll = config.bankroll
    stake = kelly * bankroll.kelly_fraction * bankroll.amount
    stake = min(stake, bankroll.max_stake_pct * bankroll.amount)
    if line.max_stake is not None:
        stake = min(stake, line.max_stake)
    if stake < bankroll.min_stake:
        return 0.0
    if bankroll.round_to > 0:
        stake = round(stake / bankroll.round_to) * bankroll.round_to
    return round(stake, 2)


def _passes_filters(line: BookLine, event: Event | None, config: Config) -> str:
    """Empty string if the line should be scanned, else the reason it was not."""
    filters = config.filters
    if line.american < filters.min_american:
        return f"price {line.american:+.0f} is below min_american"
    if line.american > filters.max_american:
        return f"price {line.american:+.0f} is above max_american"
    if event is not None:
        now = datetime.now(timezone.utc)
        if filters.skip_live and event.commence_time <= now:
            return "game has started (skip_live)"
        if event.commence_time > now + timedelta(hours=filters.max_hours_ahead):
            return f"starts more than {filters.max_hours_ahead:.0f}h out"
    return ""


def scan(
    lines: list[BookLine],
    events: list[Event],
    config: Config,
    min_ev: float | None = None,
) -> ScanResult:
    """Price each line, keeping only those clearing the EV threshold."""
    threshold = config.filters.min_ev if min_ev is None else min_ev
    result = ScanResult(lines_scanned=len(lines))

    for line in lines:
        event, reason = match_event(line, events)
        if event is None:
            result.failures.append(MatchFailure(line, reason))
            continue

        skip = _passes_filters(line, event, config)
        if skip:
            result.failures.append(MatchFailure(line, skip))
            continue

        selection, reason = resolve_selection(line, event)
        if not selection:
            result.failures.append(MatchFailure(line, reason))
            continue

        try:
            fair = fair_price(event, line.market, selection, line.point, config.market)
        except NoMarketError as exc:
            result.failures.append(MatchFailure(line, str(exc)))
            continue

        ev = ev_per_unit(fair.prob, line.decimal)
        if ev < threshold:
            result.rejected.append((line, ev))
            continue

        kelly = kelly_fraction(fair.prob, line.decimal)
        result.opportunities.append(
            Opportunity(
                line=line,
                fair=fair,
                event=event,
                ev=ev,
                kelly=kelly,
                stake=stake_for(kelly, line, config),
                ev_conservative=ev_per_unit(fair.prob_low, line.decimal),
            )
        )

    result.opportunities.sort(key=lambda o: o.ev, reverse=True)
    result.rejected.sort(key=lambda pair: pair[1], reverse=True)
    return result


def sports_needed(lines: list[BookLine], config: Config) -> list[str]:
    """Which sports to fetch, so the scan never buys credits it will not use."""
    named = [line.sport for line in lines if line.sport]
    if not named:
        return list(config.sports)
    ordered: list[str] = []
    for sport in named:
        if sport not in ordered:
            ordered.append(sport)
    return ordered


def markets_needed(lines: list[BookLine]) -> str:
    """The markets parameter for the feed, derived from your actual board."""
    wanted = {line.market for line in lines if line.market in ("h2h", "spreads", "totals")}
    return ",".join(sorted(wanted)) if wanted else "h2h,spreads,totals"
