"""Tests for the parts where being wrong costs money."""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from evscan.config import Config, MarketConfig
from evscan.devig import DevigError, devig
from evscan.fairvalue import NoMarketError, fair_price
from evscan.jsonpath import select
from evscan.matching import match_event, resolve_selection, similarity
from evscan.models import BookLine, Event, Outcome, Quote
from evscan.oddsmath import (
    OddsError,
    american_to_decimal,
    american_to_prob,
    decimal_to_american,
    ev_per_unit,
    kelly_fraction,
)
from evscan.scan import scan, stake_for
from evscan.sources.book_csv import load_lines, write_example

SOON = datetime.now(timezone.utc) + timedelta(hours=30)


# ------------------------------------------------------------------ oddsmath


@pytest.mark.parametrize(
    "american,decimal",
    [(-110, 1.909090909), (100, 2.0), (250, 3.5), (-200, 1.5), (-1000, 1.1)],
)
def test_american_decimal_round_trip(american, decimal):
    assert american_to_decimal(american) == pytest.approx(decimal, rel=1e-6)
    assert decimal_to_american(american_to_decimal(american)) == pytest.approx(
        american, abs=0.01
    )


@pytest.mark.parametrize("bad", [0, 50, -99, 99])
def test_invalid_american_odds_rejected(bad):
    """-50 is not a price. Silently accepting it would invent edge."""
    with pytest.raises(OddsError):
        american_to_decimal(bad)


def test_fair_coin_at_even_money_is_zero_ev():
    assert ev_per_unit(0.5, 2.0) == pytest.approx(0.0)


def test_ev_matches_hand_calculation():
    # 55% at -110: win 0.909 at p=.55, lose 1 at p=.45
    assert ev_per_unit(0.55, american_to_decimal(-110)) == pytest.approx(0.05, abs=1e-9)


def test_kelly_never_recommends_a_negative_stake():
    assert kelly_fraction(0.40, american_to_decimal(-110)) == 0.0


def test_kelly_known_value():
    # p=.55, b=1: f = (0.55*2 - 1)/1 = 0.10
    assert kelly_fraction(0.55, 2.0) == pytest.approx(0.10)


# --------------------------------------------------------------------- devig


def test_devig_methods_all_normalize_to_one():
    raw = [american_to_prob(-140), american_to_prob(120)]
    for method in ("multiplicative", "additive", "power", "shin"):
        assert sum(devig(raw, method)) == pytest.approx(1.0, abs=1e-9)


def test_devig_preserves_ordering():
    raw = [american_to_prob(-300), american_to_prob(250)]
    for method in ("multiplicative", "additive", "power", "shin"):
        fair = devig(raw, method)
        assert fair[0] > fair[1]


def test_balanced_market_is_a_coin_flip_under_every_method():
    raw = [american_to_prob(-110), american_to_prob(-110)]
    for method in ("multiplicative", "additive", "power", "shin"):
        assert devig(raw, method)[0] == pytest.approx(0.5, abs=1e-9)


def test_devig_refuses_an_arbitrage():
    """Probabilities summing under 1 mean stale or incomplete data."""
    with pytest.raises(DevigError):
        devig([0.45, 0.45], "multiplicative")


def test_devig_rejects_unknown_method():
    with pytest.raises(DevigError):
        devig([0.55, 0.52], "wishful")


def test_power_shrinks_the_longshot_more_than_multiplicative():
    """The favourite-longshot correction is the whole point of the method."""
    raw = [american_to_prob(-2000), american_to_prob(1100)]
    assert devig(raw, "power")[1] < devig(raw, "multiplicative")[1]


# ------------------------------------------------------------------ matching


@pytest.mark.parametrize(
    "a,b", [("Chiefs", "Kansas City Chiefs"), ("KC Chiefs", "Kansas City Chiefs"),
            ("NY Jets", "New York Jets"), ("Man United", "Manchester United"),
            ("Philly Eagles", "Philadelphia Eagles"), ("LA Kings", "Los Angeles Kings"),
            ("Giants", "New York Giants")]
)
def test_team_aliases_match(a, b):
    assert similarity(a, b) >= 0.72


@pytest.mark.parametrize(
    "a,b", [("Jets", "New York Nets"), ("Chiefs", "Buffalo Bills"),
            ("NY Giants", "San Francisco Giants"),
            ("New York Rangers", "Texas Rangers"),
            ("Carolina Panthers", "Florida Panthers"),
            ("Newcastle United", "Leeds United"),
            ("LA Kings", "Sacramento Kings")]
)
def test_different_teams_do_not_match(a, b):
    """Shared nicknames across cities are the costliest false match there is."""
    assert similarity(a, b) < 0.72


def _event(home="Kansas City Chiefs", away="Buffalo Bills", quotes=None):
    event = Event("e1", "americanfootball_nfl", SOON, home, away)
    event.quotes = list(quotes or [])
    return event


def _line(**overrides):
    base = dict(
        book="MSB247", sport="americanfootball_nfl", away_team="Buffalo Bills",
        home_team="Kansas City Chiefs", market="h2h", selection="Buffalo Bills",
        american=145.0, point=None, commence_time=SOON, max_stake=500.0,
    )
    base.update(overrides)
    return BookLine(**base)


def test_unmatched_game_is_reported_not_dropped():
    event, reason = match_event(
        _line(away_team="Nowhere United", home_team="Fake City"), [_event()]
    )
    assert event is None and "no game in the feed matches" in reason


def test_matcher_tolerates_a_board_listing_home_first():
    event, _ = match_event(
        _line(away_team="Kansas City Chiefs", home_team="Buffalo Bills"), [_event()]
    )
    assert event is not None


def test_totals_selection_must_be_over_or_under():
    name, reason = resolve_selection(
        _line(market="totals", selection="Bills"), _event()
    )
    assert name == "" and "Over or Under" in reason


# ----------------------------------------------------------------- fairvalue


def _market_quotes():
    return [
        Quote("pinnacle", "h2h", (Outcome("Buffalo Bills", 128),
                                  Outcome("Kansas City Chiefs", -140))),
        Quote("draftkings", "h2h", (Outcome("Buffalo Bills", 125),
                                    Outcome("Kansas City Chiefs", -148))),
        Quote("fanduel", "h2h", (Outcome("Buffalo Bills", 122),
                                 Outcome("Kansas City Chiefs", -145))),
    ]


def test_fair_price_sits_inside_the_range_of_book_opinions():
    fair = fair_price(_event(quotes=_market_quotes()), "h2h", "Buffalo Bills",
                      None, MarketConfig())
    assert fair.prob_low <= fair.prob <= fair.prob_high
    assert len(fair.books_used) == 3


def test_unweighted_book_is_ignored():
    quotes = _market_quotes() + [
        Quote("some_random_book", "h2h", (Outcome("Buffalo Bills", 400),
                                          Outcome("Kansas City Chiefs", -1000)))
    ]
    fair = fair_price(_event(quotes=quotes), "h2h", "Buffalo Bills", None,
                      MarketConfig())
    assert "some_random_book" not in fair.books_used


def test_wide_book_is_excluded_by_max_hold():
    config = MarketConfig(max_hold=0.02, min_books=1)
    wide = [Quote("pinnacle", "h2h", (Outcome("Buffalo Bills", 110),
                                      Outcome("Kansas City Chiefs", -150)))]
    with pytest.raises(NoMarketError):
        fair_price(_event(quotes=wide), "h2h", "Buffalo Bills", None, config)


def test_one_sided_market_cannot_be_priced():
    half = [Quote("pinnacle", "h2h", (Outcome("Buffalo Bills", 128),))]
    with pytest.raises(NoMarketError):
        fair_price(_event(quotes=half), "h2h", "Buffalo Bills", None,
                   MarketConfig(min_books=1))


def test_min_books_is_enforced():
    one = _market_quotes()[:1]
    with pytest.raises(NoMarketError):
        fair_price(_event(quotes=one), "h2h", "Buffalo Bills", None,
                   MarketConfig(min_books=2))


def test_spread_at_a_different_number_is_not_priced():
    """A +7.5 priced off a +3.5 market is invented edge, not an edge."""
    quotes = [
        Quote("pinnacle", "spreads", (Outcome("Buffalo Bills", -108, 3.5),
                                      Outcome("Kansas City Chiefs", -112, -3.5))),
        Quote("draftkings", "spreads", (Outcome("Buffalo Bills", -110, 3.5),
                                        Outcome("Kansas City Chiefs", -110, -3.5))),
    ]
    with pytest.raises(NoMarketError):
        fair_price(_event(quotes=quotes), "spreads", "Buffalo Bills", 7.5,
                   MarketConfig())


def test_totals_sides_share_the_number():
    quotes = [
        Quote("pinnacle", "totals", (Outcome("Over", -104, 47.5),
                                     Outcome("Under", -108, 47.5))),
        Quote("draftkings", "totals", (Outcome("Over", -110, 47.5),
                                       Outcome("Under", -110, 47.5))),
    ]
    fair = fair_price(_event(quotes=quotes), "totals", "Over", 47.5, MarketConfig())
    assert 0.45 < fair.prob < 0.58


# ---------------------------------------------------------------------- scan


def test_scan_finds_the_plus_ev_line_and_sizes_it():
    config = Config()
    config.bankroll.amount = 5000.0
    result = scan([_line()], [_event(quotes=_market_quotes())], config)
    assert len(result.opportunities) == 1
    opportunity = result.opportunities[0]
    assert opportunity.ev > 0.04
    assert 0 < opportunity.stake <= config.bankroll.max_stake_pct * 5000.0


def test_scan_rejects_a_bad_price_rather_than_recommending_it():
    config = Config()
    result = scan([_line(american=100)], [_event(quotes=_market_quotes())], config)
    assert not result.opportunities and result.rejected


def test_started_game_is_skipped():
    config = Config()
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    event = _event(quotes=_market_quotes())
    event.commence_time = past
    result = scan([_line(commence_time=past)], [event], config)
    assert not result.opportunities
    assert any("started" in f.reason for f in result.failures)


def test_stake_respects_account_limit():
    config = Config()
    config.bankroll.amount = 100000.0
    capped = stake_for(0.05, _line(max_stake=50.0), config)
    assert capped <= 50.0


def test_stake_respects_max_stake_pct():
    config = Config()
    config.bankroll.amount = 10000.0
    assert stake_for(0.50, _line(max_stake=None), config) <= 200.0


# ------------------------------------------------------------------- sources


def test_csv_round_trip_and_aliases(tmp_path):
    path = tmp_path / "lines.csv"
    write_example(path)
    lines = load_lines(path)
    assert len(lines) == 4
    assert lines[0].market == "h2h"          # "ml" alias
    assert lines[0].sport == "americanfootball_nfl"
    assert lines[0].max_stake == 500.0       # "limit" alias
    assert lines[2].market == "totals" and lines[2].point == 47.5


def test_write_example_refuses_to_clobber(tmp_path):
    path = tmp_path / "lines.csv"
    write_example(path)
    with pytest.raises(Exception):
        write_example(path)


def test_jsonpath_wildcards():
    doc = {"a": {"b": [{"c": 1}, {"c": 2}]}}
    assert select(doc, "a.b[*].c") == [1, 2]
    assert select(doc, "a.missing") == []
