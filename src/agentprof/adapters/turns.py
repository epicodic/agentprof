# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Assign items that carry no turn id (LLM calls, tool calls) to turns by start time."""

from bisect import bisect_right
from collections.abc import Callable, Sequence


def split_by_turn[T](
    items: Sequence[T], start_of: Callable[[T], float | None], turn_starts: Sequence[float]
) -> list[list[T]]:
    """Group `items` by turn; `turn_starts` must be ascending.

    Each turn gets the items that start at or after its own start and before the next turn's start.
    Items before the first turn, and items without a start, go to the first turn.
    """
    groups: list[list[T]] = [[] for _ in turn_starts]
    if not groups:
        return groups
    for item in items:
        start = start_of(item)
        index = 0 if start is None else max(bisect_right(turn_starts, start) - 1, 0)
        groups[index].append(item)
    return groups
