"""Odds sources.

`the_odds_api` supplies the sharp market. `book_csv` supplies your own
book's prices, which no public feed carries.
"""

from .the_odds_api import OddsAPIError, TheOddsAPI
from .book_csv import load_lines, write_example

__all__ = ["TheOddsAPI", "OddsAPIError", "load_lines", "write_example"]
