# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

"""Tests for converting native Codex rollouts to neutral trees."""

from pathlib import Path

from agentprof.adapters.codex.rollout import Rollout, ToolCall, ToolResultRecord, Turn, load_rollout
from agentprof.adapters.codex.tree import build_root
from agentprof.model import Metric, Node, NodeKind, Provenance, Tokens, ToolCategory, iter_nodes
from agentprof.pricing import PriceTable

_SESSIONS = Path(__file__).parent / "fixtures" / "sessions" / "2026" / "09" / "26"


def _main() -> Rollout:
    return load_rollout(_SESSIONS / "rollout-2026-09-26T10-00-00-root.jsonl")


def _agent() -> Rollout:
    return load_rollout(_SESSIONS / "rollout-2026-09-26T10-00-10-agent.jsonl")


def _orphan() -> Rollout:
    return load_rollout(_SESSIONS / "rollout-2026-09-26T10-01-00-orphan.jsonl")


def _prices() -> PriceTable:
    return PriceTable.load()


def _find(root: Node, node_id: str) -> Node:
    return next(node for node in iter_nodes(root) if node.node_id == node_id)


def test_build_root_nests_agent_and_maps_usage_to_one_llm_call() -> None:
    root = build_root(_main(), [_agent(), _orphan()], _prices(), "Fix parser")

    first = root.children[0]
    assert first.llm_calls[0].tokens == Tokens(
        input=Metric.exact(20), output=Metric.exact(30), cache_read=Metric.exact(60), cache_write=Metric.exact(20)
    )
    assert first.llm_calls[0].cost.provenance is Provenance.ESTIMATED
    assert first.children[2].kind is NodeKind.AGENT
    assert first.children[2].topic == "Researcher"


def test_build_root_preserves_usage_identity_and_tool_event_evidence() -> None:
    root = build_root(_main(), [_agent(), _orphan()], _prices(), "Fix parser")

    turn = root.children[0]
    root_call = turn.llm_calls[0]
    assert root_call.source_request_id == "response-1"
    assert root_call.call_id is None
    assert root_call.timing_basis == "usage_report"
    assert root_call.start == Metric.exact(1790416804000)
    assert any(event.kind == "tool_result" for event in turn.execution_events)
    assert not any(link.relation == "consumed_by" for event in turn.execution_events for link in event.links)
    assert next(event for event in turn.execution_events if event.kind == "tool_result").source_order == 5
    assert any(
        event.kind == "completion" and event.event_id == "completion:turn-2"
        for event in root.children[1].execution_events
    )
    assert any(
        event.kind == "tool_result" and event.subject_node_id == "call-delegate" and event.success is True
        for event in turn.execution_events
    )


def test_build_root_records_native_completion_and_direct_child_completion_reference() -> None:
    root = build_root(_main(), [_agent(), _orphan()], _prices(), "Fix parser")

    parent = root.children[0]
    child = _find(root, "agent-agent-thread")
    terminal = next(event for event in child.execution_events if event.kind == "completion")
    reference = next(event for event in parent.execution_events if event.kind == "child_completion")
    assert terminal.event_id == "completion:agent-turn-1"
    assert reference.event_id == "child-completion:agent-thread:completion:agent-turn-1"
    assert reference.subject_node_id == child.node_id
    assert reference.start == terminal.start


def test_build_root_emits_unmatched_result_without_subject_or_invocation_identity() -> None:
    rollout = Rollout(
        session_id="root-session",
        turns=[
            Turn(
                turn_id="turn",
                unmatched_tool_results=[ToolResultRecord(None, 250, 4, None)],
            )
        ],
    )

    turn = build_root(rollout, [], _prices(), "Working").children[0]
    result = turn.execution_events[0]

    assert result.kind == "tool_result"
    assert result.event_id is None
    assert result.subject_node_id is None
    assert result.start == Metric.exact(250)
    assert result.source_order == 4


def test_build_root_keeps_missing_id_start_unaddressable_and_orders_overlapping_records() -> None:
    rollout = Rollout(
        session_id="root-session",
        turns=[
            Turn(
                turn_id="turn",
                tools=[
                    ToolCall(
                        call_id="first",
                        name="exec",
                        input="{}",
                        start_ms=100,
                        end_ms=300,
                        start_order=1,
                        result_order=3,
                        result_recorded=True,
                    ),
                    ToolCall(
                        call_id=None,
                        name="read",
                        input="{}",
                        start_ms=110,
                        end_ms=200,
                        start_order=2,
                        result_order=4,
                        result_recorded=True,
                    ),
                ],
            )
        ],
    )

    turn = build_root(rollout, [], _prices(), "Working").children[0]
    events = turn.execution_events
    unaddressable = next(event for event in events if event.source_order == 2)

    assert [(event.kind, event.source_order) for event in events] == [
        ("tool_start", 1),
        ("tool_start", 2),
        ("tool_result", 3),
        ("tool_result", 4),
    ]
    assert unaddressable.event_id is None
    assert unaddressable.subject_node_id is None


def test_build_root_preserves_turn_and_tool_timing_and_status() -> None:
    root = build_root(_main(), [_agent(), _orphan()], _prices(), "Fix parser")

    first, second = root.children
    shell = _find(root, "call-shell")
    assert first.start == Metric.exact(1790416800200)
    assert first.end == Metric.exact(1790416804100)
    assert second.topic == "Summarize the findings."
    assert (shell.start, shell.end, shell.duration, shell.success) == (
        Metric.exact(1790416801000),
        Metric.exact(1790416801500),
        Metric.exact(500),
        True,
    )
    assert shell.tool is not None
    assert shell.tool.category is ToolCategory.SHELL


def test_build_root_keeps_unmatched_agents_on_the_parent_turn() -> None:
    root = build_root(_main(), [_agent(), _orphan()], _prices(), "Fix parser")

    orphan = _find(root, "agent-orphan-thread")
    assert orphan.kind is NodeKind.AGENT
    assert orphan.topic == "Unlinked helper"
    assert orphan.llm_call_count == Metric.exact(1)
    assert orphan.children == []


def test_build_root_leaves_a_running_subagent_end_unknown() -> None:
    main = Rollout(
        session_id="root-session",
        turns=[
            Turn(
                turn_id="parent-turn",
                start_ms=100,
                end_ms=200,
                tools=[ToolCall(call_id="spawn", name="spawn_agent", input='{"nickname":"Worker"}', start_ms=110)],
            )
        ],
    )
    worker = Rollout(
        session_id="root-session",
        thread_id="worker-thread",
        parent_thread_id="root-session",
        agent_nickname="Worker",
        turns=[
            Turn(turn_id="finished", start_ms=120, end_ms=150),
            Turn(
                turn_id="running", start_ms=160, tools=[ToolCall(call_id="tool", name="exec", input="{}", start_ms=170)]
            ),
        ],
    )

    root = build_root(main, [worker], _prices(), "Working")

    agent = _find(root, "agent-worker-thread")
    assert agent.end == Metric.not_available()
    assert agent.duration == Metric.not_available()


def test_build_root_places_an_unmatched_agent_on_its_starting_turn() -> None:
    root = build_root(_main(), [_orphan()], _prices(), "Fix parser")

    first, second = root.children
    assert all(child.node_id != "agent-orphan-thread" for child in first.children)
    assert any(child.node_id == "agent-orphan-thread" for child in second.children)


def test_build_root_nests_agents_when_child_rollout_precedes_parent() -> None:
    parent = _agent()
    parent.turns[0].tools.append(
        ToolCall(
            call_id="call-child",
            name="spawn_agent",
            input='{"nickname":"Reviewer"}',
            start_ms=1790416811200,
        )
    )
    child = Rollout(
        session_id="root-session",
        thread_id="child-thread",
        parent_thread_id="agent-thread",
        agent_nickname="Reviewer",
        turns=[Turn(turn_id="child-turn", start_ms=1790416811300, end_ms=1790416811400)],
    )

    root = build_root(_main(), [child, parent], _prices(), "Fix parser")

    nested_parent = _find(root, "agent-agent-thread")
    assert nested_parent.agent_uuid == "agent-thread"
    assert [child.node_id for child in nested_parent.children if child.kind is NodeKind.AGENT] == ["agent-child-thread"]


def test_build_root_keeps_multiple_same_named_subagents() -> None:
    main = _main()
    main.turns[0].tools.extend(
        [
            ToolCall(call_id="call-first", name="spawn_agent", input='{"nickname":"Reviewer"}', start_ms=1790416801200),
            ToolCall(
                call_id="call-second", name="spawn_agent", input='{"nickname":"Reviewer"}', start_ms=1790416801300
            ),
        ]
    )
    first = Rollout(
        session_id="root-session",
        thread_id="first-reviewer",
        parent_thread_id="root-session",
        agent_nickname="Reviewer",
        turns=[Turn(turn_id="first-turn", start_ms=1790416801400, end_ms=1790416801500)],
    )
    second = Rollout(
        session_id="root-session",
        thread_id="second-reviewer",
        parent_thread_id="root-session",
        agent_nickname="Reviewer",
        turns=[Turn(turn_id="second-turn", start_ms=1790416801600, end_ms=1790416801700)],
    )

    root = build_root(main, [first, second], _prices(), "Fix parser")

    assert [node.node_id for node in iter_nodes(root) if node.kind is NodeKind.AGENT] == [
        "agent-first-reviewer",
        "agent-second-reviewer",
    ]


def test_build_root_creates_a_synthetic_turn_for_activity_without_a_prompt() -> None:
    main = _main()
    main.turns[0].prompt = None
    main.turns[1].prompt = None

    root = build_root(main, [], _prices(), "Fix parser")

    assert [turn.node_id for turn in root.children] == ["turn-1", "turn-2"]
    assert root.children[0].topic == "(no prompt)"


def test_build_root_leaves_unknown_models_unpriced() -> None:
    main = _main()
    main.turns[0].model = "gpt-unknown"

    root = build_root(main, [], _prices(), "Fix parser")

    assert root.children[0].llm_calls[0].cost.value is None


def test_build_root_uses_delegation_task_and_agent_message() -> None:
    root = build_root(_main(), [_agent()], _prices(), "Fix parser")

    agent = _find(root, "agent-agent-thread")

    assert agent.prompt == "Read the documentation."
    assert agent.result == "Documentation reviewed."


def test_build_root_labels_an_encrypted_delegation_handover_unavailable() -> None:
    main = _main()
    main.turns[0].tools[2].input = '{"message":"gAAAA-encrypted"}'

    root = build_root(main, [_agent()], _prices(), "Fix parser")

    assert _find(root, "agent-agent-thread").prompt == "Handover unavailable: Codex stored it encrypted."


def test_build_root_reports_patch_wrapped_by_exec_as_an_artifact() -> None:
    main = _main()
    main.turns[0].tools.append(
        ToolCall(
            call_id="wrapped-patch",
            name="exec",
            input='const patch = "*** Begin Patch\\n*** Update File: src/wrapped.py\\n*** End Patch"',
            start_ms=1790416801200,
        )
    )

    root = build_root(main, [], _prices(), "Fix parser")
    tool = _find(root, "wrapped-patch")

    assert tool.tool is not None
    assert tool.tool.category is ToolCategory.EDIT
    assert tool.tool.paths == ("src/wrapped.py",)
