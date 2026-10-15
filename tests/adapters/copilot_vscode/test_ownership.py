# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from collections import Counter
from dataclasses import replace

import pytest

from agentprof.adapters.copilot_vscode.ownership import OwnershipContext, decide_owner


def _context(**changes: object) -> OwnershipContext:
    context = OwnershipContext(
        root_sid="root-sid",
        agents=frozenset({"a1", "a2"}),
        invocation_owners={"t1": "a1"},
        ambiguous_tool_ids=frozenset({"dup"}),
        event_id_counts=Counter({"p1": 1}),
    )
    return replace(context, **changes)


_CASES: list[tuple[dict[str, object], dict[str, object], tuple[str | None, str, bool], str]] = [
    ({"type": "assistant.message", "data": {}}, {}, (None, "root", False), "root"),
    ({"type": "assistant.message", "data": {}}, {"active": [None, "a1"]}, ("a1", "bracket", False), "bracket"),
    (
        {"type": "assistant.message", "parentId": "p1", "data": {}},
        {"owner_by_event": {"p1": "a2"}},
        ("a2", "recorded_parent", False),
        "recorded_parent",
    ),
    ({"type": "assistant.message", "parentId": "p9", "data": {}}, {}, (None, "ambiguous", True), "unknown_parent"),
    ({"type": "assistant.message", "data": {"agentId": "a2"}}, {}, ("a2", "explicit_owner", False), "explicit_owner"),
    (
        {"type": "assistant.message", "data": {"agentId": "root-sid"}},
        {},
        (None, "explicit_owner", False),
        "explicit_root_owner",
    ),
    ({"type": "assistant.message", "data": {"agentId": "zz"}}, {}, (None, "ambiguous", True), "unknown_agent"),
    (
        {"type": "tool.execution_start", "data": {"toolCallId": "t1"}},
        {},
        ("a1", "explicit_invocation_parent", False),
        "explicit_invocation_parent",
    ),
    (
        {"type": "tool.execution_start", "data": {"toolCallId": "t1", "agentId": "a2"}},
        {},
        (None, "ambiguous_conflicting_owner", True),
        "conflicting_start_owner",
    ),
    (
        {"type": "tool.execution_start", "data": {"toolCallId": "dup"}},
        {},
        (None, "ambiguous_invocation", True),
        "ambiguous_invocation",
    ),
    (
        {"type": "tool.execution_complete", "data": {"toolCallId": "t2"}},
        {"ambiguous_start_ids": {"t2"}},
        (None, "ambiguous_invocation", True),
        "ambiguous_start",
    ),
    (
        {"type": "tool.execution_complete", "data": {"toolCallId": "t2"}},
        {"start_owner": {"t2": "a2"}},
        ("a2", "invocation_owner", False),
        "invocation_owner",
    ),
    (
        {"type": "tool.execution_complete", "data": {"toolCallId": "t2", "agentId": "a1"}},
        {"start_owner": {"t2": "a2"}},
        (None, "ambiguous_conflicting_owner", True),
        "conflicting_result_owner",
    ),
    (
        {"type": "assistant.message", "data": {}},
        {"active": [None, "a1"], "parallel_active": {"a1", "a2"}},
        (None, "ambiguous_parallel", True),
        "ambiguous_parallel",
    ),
    (
        {"type": "user.message", "data": {}},
        {"active": [None, "a1"], "parallel_active": {"a1", "a2"}},
        (None, "root", True),
        "user_message_without_owner_is_root",
    ),
]

_EXPECTED = [expected for _, _, expected, _ in _CASES]
_PARAMS = [pytest.param(event, changes, expected, id=case_id) for event, changes, expected, case_id in _CASES]


@pytest.mark.parametrize(("event", "changes", "expected"), _PARAMS)
def test_decide_owner(
    event: dict[str, object], changes: dict[str, object], expected: tuple[str | None, str, bool]
) -> None:
    decision = decide_owner(event, _context(**changes))

    assert (decision.owner_key, decision.evidence, decision.ambiguous) == expected


def test_every_evidence_value_has_a_case() -> None:
    evidence = {expected[1] for expected in _EXPECTED}

    assert evidence == {
        "root",
        "bracket",
        "recorded_parent",
        "ambiguous",
        "explicit_owner",
        "explicit_invocation_parent",
        "ambiguous_conflicting_owner",
        "ambiguous_invocation",
        "invocation_owner",
        "ambiguous_parallel",
    }


def test_observe_tracks_open_subagents_and_parents() -> None:
    context = _context()
    start = {"type": "tool.execution_start", "id": "e1", "data": {"toolCallId": "a2", "toolName": "runSubagent"}}
    context.event_id_counts["e1"] = 1

    context.observe(start, decide_owner(start, context), delegation_child_id="a2")

    assert context.active == [None, "a2"]
    assert context.owner_by_event == {"e1": "a2"}
    assert context.start_owner == {"a2": None}

    complete = {"type": "tool.execution_complete", "data": {"toolCallId": "a2"}}
    context.observe(complete, decide_owner(complete, context), delegation_child_id=None)

    assert context.active == [None]


def test_a_subagent_started_outside_the_open_one_runs_in_parallel() -> None:
    context = _context(active=[None, "a1"])
    start = {"type": "tool.execution_start", "data": {"toolCallId": "a2", "agentId": "root-sid"}}

    context.observe(start, decide_owner(start, context), delegation_child_id="a2")

    assert context.active == [None, "a1", "a2"]
    assert context.parallel_active == {"a1", "a2"}
    message = {"type": "assistant.message", "data": {}}
    assert decide_owner(message, context).evidence == "ambiguous_parallel"

    complete = {"type": "tool.execution_complete", "data": {"toolCallId": "a2", "agentId": "root-sid"}}
    context.observe(complete, decide_owner(complete, context), delegation_child_id=None)

    assert context.active == [None, "a1"]
    assert context.parallel_active == set()
