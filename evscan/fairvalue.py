"""Turning a set of book prices into one fair probability.

The scanner's entire claim is "your book's price beats the real one". That
claim is only as good as the fair probability behind it, so this module is
deliberately conservative:

  - only books with a named weight count, sharp books far above retail
  - a book quoting a wider margin than `max_hold` is ignored entirely
  - a market missing a side cannot be de-vigged, so it is skipped rather
    than guessed at
  - the spread of opinion across books is reported, not hidden, because a
    2% edge over books that disagree by 4% is not an edge

Alongside the weighted consensus it returns the sharpest single book's
number and the most pessimistic book's number, so `scan` can tell you
whether an edge survives the least friendly reading of the market.
"""

from __future__ import annotations

from .config import MarketConfig
from .devig import DevigError, devig
from .matching import find_outcome, normalize, opposite_point
from .models import Event, FairPrice, Outcome, Quote


class NoMarketError(ValueError):
    """Raised when no usable book prices the selection."""


def _sided_outcomes(quote: Quote, market: str, point: float | None) -> list[Outcome]:
    """The outcomes forming one complete two-sided market at `point`.

    A feed may carry several numbers for the same market (alternate lines).
    De-vigging across mismatched numbers is meaningless, so the pair is
    isolated first.
    """
    if market == "h2h" or point is None:
        return [o for o in quote.outcomes if o.point is None] or list(quote.outcomes)

    if market == "totals":
        # Over and Under share the number.
        return [
            o for o in quote.outcomes
            if o.point is not None and abs(o.point - point) < 1e-9
        ]

    # Spreads: the two sides are equal and opposite.
    other = opposite_point(market, point)
    return [
        o for o in quote.outcomes
        if o.point is not None
        and (abs(o.point - point) < 1e-9 or abs(o.point - other) < 1e-9)
    ]


def probability_from_quote(
    quote: Quote,
    market: str,
    selection: str,
    point: float | None,
    method: str,
) -> float | None:
    """De-vig one book's market and return its fair probability for `selection`.

    Returns None when this book cannot price the selection cleanly.
    """
    outcomes = _sided_outcomes(quote, market, point)
    if len(outcomes) < 2:
        return None

    target = normalize(selection)
    index = next(
        (i for i, o in enumerate(outcomes) if normalize(o.name) == target), None
    )
    if index is None:
        return None

    try:
        fair = devig([o.implied for o in outcomes], method)
    except DevigError:
        return None
    return fair[index]


def fair_price(
    event: Event,
    market: str,
    selection: str,
    point: float | None,
    config: MarketConfig,
) -> FairPrice:
    """Consensus fair probability for one selection across the market.

    Raises NoMarketError with a readable explanation when the market cannot
    be priced -- the caller surfaces that to the user rather than dropping
    the line silently.
    """
    quotes = event.quotes_for(market)
    if not quotes:
        raise NoMarketError(f"no book in the feed posts {market} for this game")

    weighted: list[tuple[str, float, float]] = []   # (book, prob, weight)
    holds: list[float] = []
    too_wide = 0
    no_price = 0

    for quote in quotes:
        weight = config.weight_for(quote.book)
        if weight is None or weight <= 0:
            continue
        outcomes = _sided_outcomes(quote, market, point)
        if len(outcomes) < 2:
            no_price += 1
            continue
        quote_hold = (sum(o.implied for o in outcomes) - 1.0) / sum(
            o.implied for o in outcomes
        )
        if quote_hold > config.max_hold:
            too_wide += 1
            continue
        prob = probability_from_quote(quote, market, selection, point, config.devig)
        if prob is None:
            no_price += 1
            continue
        weighted.append((quote.book, prob, weight))
        holds.append(quote_hold)

    if not weighted:
        detail = []
        if too_wide:
            detail.append(f"{too_wide} book(s) quoting wider than {config.max_hold:.1%}")
        if no_price:
            detail.append(f"{no_price} book(s) without this exact number")
        suffix = f" ({'; '.join(detail)})" if detail else ""
        raise NoMarketError(f"no reference book prices this selection{suffix}")

    if len(weighted) < config.min_books:
        books = ", ".join(b for b, _p, _w in weighted)
        raise NoMarketError(
            f"only {len(weighted)} book(s) price this ({books}); "
            f"min_books is {config.min_books}"
        )

    total_weight = sum(w for _b, _p, w in weighted)
    consensus = sum(p * w for _b, p, w in weighted) / total_weight

    # The sharpest book present, judged alone.
    reference = [(b, p, w) for b, p, w in weighted if config.is_reference(b)]
    sharpest = max(reference or weighted, key=lambda item: item[2])

    probs = [p for _b, p, _w in weighted]
    return FairPrice(
        prob=consensus,
        prob_sharp=sharpest[1],
        prob_low=min(probs),
        prob_high=max(probs),
        books_used=[b for b, _p, _w in weighted],
        method=config.devig,
        mean_hold=sum(holds) / len(holds),
    )
