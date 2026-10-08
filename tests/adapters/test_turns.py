# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from agentprof.adapters.turns import split_by_turn


def _start(item: tuple[str, int | None]) -> int | None:
    return item[1]


def test_split_by_turn_assigns_items_to_the_latest_turn_started_before_them() -> None:
    items = [("a", 5), ("b", 10), ("c", 19), ("d", 20), ("e", 35)]

    groups = split_by_turn(items, _start, [10, 20, 30])

    assert groups == [[("a", 5), ("b", 10), ("c", 19)], [("d", 20)], [("e", 35)]]


def test_split_by_turn_puts_items_without_start_into_the_first_turn() -> None:
    assert split_by_turn([("a", None)], _start, [10, 20]) == [[("a", None)], []]


def test_split_by_turn_without_turns_returns_no_groups() -> None:
    assert split_by_turn([("a", 1)], _start, []) == []
