"""Odds conversions and expected-value math.

Everything downstream speaks in one of three currencies:

    american  -- the number your book shows you (-110, +250)
    decimal   -- total return per unit staked (1.909, 3.50)
    prob      -- implied probability, 0..1 (0.5238, 0.2857)

Implied probability from a posted price is *not* a real probability: it
carries the book's margin. Stripping that margin out is `devig.py`'s job.
"""

from __future__ import annotations


class OddsError(ValueError):
    """Raised for prices that cannot represent a real wager."""


def american_to_decimal(american: float) -> float:
    """Convert American odds to decimal (total return per unit staked)."""
    if -100 < american < 100:
        raise OddsError(f"american odds must be <= -100 or >= +100, got {american}")
    if american > 0:
        return 1.0 + american / 100.0
    return 1.0 + 100.0 / abs(american)


def decimal_to_american(decimal: float) -> float:
    """Convert decimal odds back to American."""
    if decimal <= 1.0:
        raise OddsError(f"decimal odds must be > 1.0, got {decimal}")
    if decimal >= 2.0:
        return round((decimal - 1.0) * 100.0, 2)
    return round(-100.0 / (decimal - 1.0), 2)


def decimal_to_prob(decimal: float) -> float:
    """Implied probability of a decimal price (margin still included)."""
    if decimal <= 1.0:
        raise OddsError(f"decimal odds must be > 1.0, got {decimal}")
    return 1.0 / decimal


def prob_to_decimal(prob: float) -> float:
    """Fair decimal price for a probability."""
    if not 0.0 < prob < 1.0:
        raise OddsError(f"probability must be strictly between 0 and 1, got {prob}")
    return 1.0 / prob


def american_to_prob(american: float) -> float:
    return decimal_to_prob(american_to_decimal(american))


def prob_to_american(prob: float) -> float:
    return decimal_to_american(prob_to_decimal(prob))


def hold(probs: list[float]) -> float:
    """Book margin on a market, as a fraction of handle.

    `probs` are the raw implied probabilities of every outcome. A two-way
    -110/-110 market holds ~4.55%.
    """
    total = sum(probs)
    if total <= 0:
        raise OddsError("cannot compute hold on an empty market")
    return (total - 1.0) / total


def overround(probs: list[float]) -> float:
    """Sum of implied probabilities minus 1. -110/-110 => 0.0476."""
    return sum(probs) - 1.0


def ev_per_unit(prob: float, decimal: float) -> float:
    """Expected profit per unit staked.

    Positive means the price pays more than the risk is worth:
        ev = prob * (decimal - 1) - (1 - prob)
           = prob * decimal - 1
    """
    return prob * decimal - 1.0


def kelly_fraction(prob: float, decimal: float) -> float:
    """Full-Kelly stake as a fraction of bankroll.

    f* = (p*b - q) / b  where b = decimal - 1. Returns 0.0 for a -EV price
    rather than a negative stake (this scanner never advises laying).
    """
    b = decimal - 1.0
    if b <= 0:
        raise OddsError(f"decimal odds must be > 1.0, got {decimal}")
    f = (prob * decimal - 1.0) / b
    return max(0.0, f)


def format_american(american: float) -> str:
    """Render American odds the way a book displays them."""
    rounded = round(american)
    return f"+{rounded:.0f}" if rounded > 0 else f"{rounded:.0f}"
