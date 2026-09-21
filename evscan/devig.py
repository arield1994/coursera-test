"""Removing the bookmaker margin from a set of posted prices.

A market's implied probabilities always sum to more than 1. The excess is
the book's margin, and how you redistribute it changes your fair price --
sometimes by more than the edge you think you found. Four methods, because
no single one is right for every market:

    multiplicative  scale every probability by the same factor. Simple,
                    standard, and the usual default. Takes proportionally
                    more margin off the favorite.
    additive        subtract the margin equally across outcomes. Takes more
                    off the longshot in relative terms; harmless on a
                    balanced two-way, distorting on lopsided markets.
    power           solve sum(p**k) = 1. Handles favorite-longshot bias --
                    the empirical finding that longshots carry more vig than
                    their price suggests. Best default for heavy favorites.
    shin            solves for the share of insider money the book is
                    protecting against. Conservative on lopsided markets.

When the market is lopsided (a -2000 favorite), multiplicative and power can
disagree by several EV points. `compare` exists so you can see that before
you bet.
"""

from __future__ import annotations

METHODS = ("multiplicative", "additive", "power", "shin")

_TOL = 1e-12
_MAX_ITER = 200


class DevigError(ValueError):
    """Raised when a set of prices cannot be de-vigged."""


def _validate(probs: list[float]) -> None:
    if len(probs) < 2:
        raise DevigError("need at least two outcomes to remove vig")
    if any(p <= 0.0 for p in probs):
        raise DevigError("every implied probability must be positive")
    if sum(probs) <= 1.0:
        raise DevigError(
            f"implied probabilities sum to {sum(probs):.4f} (<= 1.0): this is an "
            "arbitrage or a stale/incomplete market, not a book with margin"
        )


def multiplicative(probs: list[float]) -> list[float]:
    """Normalize so the probabilities sum to 1."""
    _validate(probs)
    total = sum(probs)
    return [p / total for p in probs]


def additive(probs: list[float]) -> list[float]:
    """Subtract the margin evenly across outcomes.

    Falls back to multiplicative if the even subtraction would drive any
    outcome to zero or below (happens on very lopsided markets).
    """
    _validate(probs)
    n = len(probs)
    excess = (sum(probs) - 1.0) / n
    fair = [p - excess for p in probs]
    if any(f <= 0.0 for f in fair):
        return multiplicative(probs)
    return fair


def power(probs: list[float]) -> list[float]:
    """Solve sum(p**k) = 1 for k, via bisection.

    k > 1 always (since sum(p) > 1), which shrinks longshots harder than
    favorites -- the correction for favorite-longshot bias.
    """
    _validate(probs)
    lo, hi = 1.0, 2.0
    # Expand the bracket until sum(p**hi) drops below 1.
    for _ in range(_MAX_ITER):
        if sum(p**hi for p in probs) < 1.0:
            break
        hi *= 2.0
    else:
        raise DevigError("power method failed to bracket a solution")

    for _ in range(_MAX_ITER):
        mid = (lo + hi) / 2.0
        total = sum(p**mid for p in probs)
        if abs(total - 1.0) < _TOL:
            break
        if total > 1.0:
            lo = mid
        else:
            hi = mid
    k = (lo + hi) / 2.0
    fair = [p**k for p in probs]
    total = sum(fair)
    return [f / total for f in fair]


def shin(probs: list[float]) -> list[float]:
    """Shin (1993): back out the implied share of insider money, z.

    Treats the margin as the book's defence against informed bettors rather
    than a flat tax, which pulls less probability off longshots than
    multiplicative does.
    """
    _validate(probs)
    total = sum(probs)

    def fair_for(z: float) -> list[float]:
        if z <= 0.0:
            return [p / total for p in probs]
        out = []
        for p in probs:
            disc = z * z + 4.0 * (1.0 - z) * (p * p) / total
            out.append((max(disc, 0.0) ** 0.5 - z) / (2.0 * (1.0 - z)))
        return out

    lo, hi = 0.0, 0.99
    for _ in range(_MAX_ITER):
        mid = (lo + hi) / 2.0
        s = sum(fair_for(mid))
        if abs(s - 1.0) < _TOL:
            break
        if s > 1.0:
            lo = mid
        else:
            hi = mid
    fair = fair_for((lo + hi) / 2.0)
    s = sum(fair)
    return [f / s for f in fair]


_DISPATCH = {
    "multiplicative": multiplicative,
    "additive": additive,
    "power": power,
    "shin": shin,
}


def devig(probs: list[float], method: str = "multiplicative") -> list[float]:
    """Strip the margin from `probs` using the named method."""
    try:
        fn = _DISPATCH[method]
    except KeyError:
        raise DevigError(
            f"unknown devig method {method!r}; choose from {', '.join(METHODS)}"
        ) from None
    return fn(probs)


def compare(probs: list[float]) -> dict[str, list[float]]:
    """Run every method, so you can see how much the choice matters."""
    out = {}
    for name in METHODS:
        try:
            out[name] = devig(probs, name)
        except DevigError:
            continue
    return out
