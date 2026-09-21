"""Configuration loading.

Settings come from evscan.toml (see evscan.example.toml). Anything absent
falls back to the defaults here, so a missing config file is not an error.
The API key is read from the environment, never the config file -- keys do
not belong in a repo.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_CONFIG_PATHS = ("evscan.toml", "~/.config/evscan/evscan.toml")

# Reference books, in descending order of how much their price is worth.
# Weights feed the consensus fair probability; the first book present is
# also reported on its own as the "sharp" number.
DEFAULT_REFERENCE_WEIGHTS = {
    "pinnacle": 1.00,
    "circasports": 0.90,
    "betonlineag": 0.55,
    "lowvig": 0.55,
    "bookmaker": 0.55,
    "betcris": 0.50,
}

# Retail books. Not sharp individually, but their consensus is a usable
# fallback when no reference book has the market (common on props).
DEFAULT_FALLBACK_WEIGHTS = {
    "draughtkings": 0.0,  # guard against a common typo in hand-edited config
    "draftkings": 0.30,
    "fanduel": 0.30,
    "betmgm": 0.22,
    "williamhill_us": 0.22,
    "espnbet": 0.18,
    "betrivers": 0.18,
    "hardrockbet": 0.15,
}


class ConfigError(ValueError):
    """Raised for a config file that cannot be used as written."""


@dataclass
class BookConfig:
    name: str = "MSB247"
    lines_file: str = "lines.csv"


@dataclass
class MarketConfig:
    reference_weights: dict[str, float] = field(
        default_factory=lambda: dict(DEFAULT_REFERENCE_WEIGHTS)
    )
    fallback_weights: dict[str, float] = field(
        default_factory=lambda: dict(DEFAULT_FALLBACK_WEIGHTS)
    )
    devig: str = "multiplicative"
    min_books: int = 2
    max_hold: float = 0.08          # ignore a book quoting worse than this
    allow_fallback: bool = True     # use retail consensus when no sharp book has it
    regions: str = "us,us2,eu"
    odds_format: str = "american"

    def weight_for(self, book: str) -> float | None:
        if book in self.reference_weights:
            return self.reference_weights[book]
        if self.allow_fallback:
            return self.fallback_weights.get(book)
        return None

    def is_reference(self, book: str) -> bool:
        return book in self.reference_weights


@dataclass
class FilterConfig:
    min_ev: float = 0.01            # 1% -- below this, vig noise dominates
    min_american: float = -400.0    # skip heavy chalk; bankroll risk is poor
    max_american: float = 1000.0    # skip lottery tickets; models are worst here
    skip_live: bool = True          # in-play lines move faster than a scan
    max_hours_ahead: float = 240.0  # 10 days; lines this early are unreliable


@dataclass
class BankrollConfig:
    amount: float = 1000.0
    kelly_fraction: float = 0.25    # quarter Kelly; full Kelly is too wild
    max_stake_pct: float = 0.02     # never risk more than 2% on one bet
    min_stake: float = 1.0
    round_to: float = 1.0


@dataclass
class Config:
    book: BookConfig = field(default_factory=BookConfig)
    market: MarketConfig = field(default_factory=MarketConfig)
    filters: FilterConfig = field(default_factory=FilterConfig)
    bankroll: BankrollConfig = field(default_factory=BankrollConfig)
    http_book: object | None = None   # populated from [book.http], if present
    sports: list[str] = field(
        default_factory=lambda: [
            "americanfootball_nfl",
            "basketball_nba",
            "baseball_mlb",
            "icehockey_nhl",
        ]
    )
    source_path: Path | None = None

    @property
    def api_key(self) -> str | None:
        return os.environ.get("ODDS_API_KEY") or None


def _merge(section: dict, target) -> None:
    """Copy known keys from a TOML table onto a dataclass instance."""
    known = set(vars(target))
    for key, value in section.items():
        if key not in known:
            raise ConfigError(
                f"unknown setting {key!r} in [{type(target).__name__}] section"
            )
        setattr(target, key, value)


def find_config(explicit: str | None = None) -> Path | None:
    if explicit:
        path = Path(explicit).expanduser()
        if not path.exists():
            raise ConfigError(f"config file not found: {path}")
        return path
    for candidate in DEFAULT_CONFIG_PATHS:
        path = Path(candidate).expanduser()
        if path.exists():
            return path
    return None


def load(explicit: str | None = None) -> Config:
    """Load config, falling back to defaults when no file exists."""
    cfg = Config()
    path = find_config(explicit)
    if path is None:
        return cfg

    with path.open("rb") as fh:
        raw = tomllib.load(fh)

    cfg.source_path = path
    if "sports" in raw:
        cfg.sports = list(raw["sports"])

    # [book.http] is an optional sub-table describing your book's own endpoint.
    # It is only parsed when enabled, so a drafted-but-unfinished block is inert.
    http_raw = dict(raw.get("book", {})).pop("http", None) or raw.get("book", {}).get("http")
    if http_raw:
        raw["book"] = {k: v for k, v in raw["book"].items() if k != "http"}
        if http_raw.get("enabled"):
            from .sources.book_http import BookHTTPError, HTTPBookConfig
            try:
                cfg.http_book = HTTPBookConfig.from_dict(dict(http_raw))
            except BookHTTPError as exc:
                raise ConfigError(f"[book.http]: {exc}") from None
    for name, target in (
        ("book", cfg.book),
        ("market", cfg.market),
        ("filters", cfg.filters),
        ("bankroll", cfg.bankroll),
    ):
        if name in raw:
            _merge(raw[name], target)

    if cfg.market.devig not in ("multiplicative", "additive", "power", "shin"):
        raise ConfigError(f"market.devig is not a known method: {cfg.market.devig!r}")
    if not 0.0 < cfg.bankroll.kelly_fraction <= 1.0:
        raise ConfigError("bankroll.kelly_fraction must be in (0, 1]")
    return cfg
