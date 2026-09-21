"""A tiny path selector for walking unknown JSON payloads.

Your book's API shape is whatever it is, so the adapter is driven by paths
written in config rather than hardcoded field names:

    "data.games[*].lines[*].price"   every price, at any depth
    "events[0].id"                   one specific element
    "odds.*.value"                   every value of an object

Deliberately not full JSONPath -- no filters, no recursion operators. If a
payload needs more than this, it needs a real adapter, not a longer path.
"""

from __future__ import annotations

import re
from typing import Any, Iterator

_INDEX = re.compile(r"\[(\*|-?\d+)\]")


def _segments(path: str) -> list[tuple[str, list[str]]]:
    """Split "a.b[*].c" into [("a", []), ("b", ["*"]), ("c", [])]."""
    parts = []
    for raw in path.split("."):
        if not raw:
            continue
        indices = _INDEX.findall(raw)
        key = _INDEX.sub("", raw)
        parts.append((key, indices))
    return parts


def _descend(value: Any, key: str) -> Iterator[Any]:
    if key == "" or key == "*":
        if isinstance(value, dict):
            yield from value.values()
        elif isinstance(value, list):
            yield from value
        return
    if isinstance(value, dict):
        if key in value:
            yield value[key]
        return
    if isinstance(value, list):
        # Allow skipping an array level: "games.name" works on a list of games.
        for item in value:
            if isinstance(item, dict) and key in item:
                yield item[key]


def _index(value: Any, token: str) -> Iterator[Any]:
    if not isinstance(value, list):
        return
    if token == "*":
        yield from value
        return
    position = int(token)
    if -len(value) <= position < len(value):
        yield value[position]


def select(data: Any, path: str) -> list[Any]:
    """Every value matching `path`. Missing paths yield an empty list."""
    current = [data]
    for key, indices in _segments(path):
        nxt: list[Any] = []
        for item in current:
            for value in _descend(item, key):
                nxt.append(value)
        current = nxt
        for token in indices:
            expanded: list[Any] = []
            for item in current:
                expanded.extend(_index(item, token))
            current = expanded
        if not current:
            return []
    return current


def select_one(data: Any, path: str, default: Any = None) -> Any:
    """First match for `path`, or `default`."""
    found = select(data, path)
    return found[0] if found else default


def walk(data: Any, prefix: str = "") -> Iterator[tuple[str, Any]]:
    """Every (path, scalar) pair in a payload. Used to profile unknown JSON."""
    if isinstance(data, dict):
        for key, value in data.items():
            yield from walk(value, f"{prefix}.{key}" if prefix else str(key))
    elif isinstance(data, list):
        for item in data[:3]:   # three samples is enough to infer a shape
            yield from walk(item, f"{prefix}[*]")
    else:
        yield prefix, data


def shape(data: Any, max_paths: int = 60) -> list[tuple[str, str, Any]]:
    """Summarize a payload as (path, type, example). For endpoint discovery."""
    seen: dict[str, tuple[str, Any]] = {}
    for path, value in walk(data):
        if path not in seen:
            seen[path] = (type(value).__name__, value)
        if len(seen) >= max_paths:
            break
    return [(p, t, v) for p, (t, v) in seen.items()]
