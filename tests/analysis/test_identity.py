# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from agentprof.analysis.identity import MAIN_OWNER, assign_call_keys, call_keys, owned_nodes, timestamp_key
from agentprof.model import LlmCall, Metric, Node, NodeKind


def test_owned_nodes_yields_every_node_depth_first_with_its_logical_owner() -> None:
    nested = Node(node_id="nested", kind=NodeKind.AGENT, topic="nested")
    tool = Node(node_id="tool", kind=NodeKind.TOOL, topic="tool", children=[nested])
    resumed = Node(node_id="resumed", kind=NodeKind.AGENT, topic="again", agent_uuid="agent-1")
    agent = Node(node_id="agent", kind=NodeKind.AGENT, topic="agent", agent_uuid="agent-1", children=[tool])
    turn = Node(node_id="turn", kind=NodeKind.TURN, topic="turn", children=[agent, resumed])
    root = Node(node_id="root", kind=NodeKind.SESSION, topic="root", children=[turn])

    assert [(owner, node.node_id) for owner, node in owned_nodes(root)] == [
        (MAIN_OWNER, "root"),
        (MAIN_OWNER, "turn"),
        ("agent-1", "agent"),
        ("agent-1", "tool"),
        ("nested", "nested"),
        ("agent-1", "resumed"),
    ]


def test_call_keys_prefer_a_unique_native_id() -> None:
    calls = [LlmCall(start=Metric.exact(1), call_id="a"), LlmCall(start=Metric.exact(1), call_id="b")]

    assert call_keys(calls) == ["id:a", "id:b"]


def test_duplicate_native_ids_never_fall_back_to_time() -> None:
    calls = [LlmCall(start=Metric.exact(1), call_id="same"), LlmCall(start=Metric.exact(2), call_id="same")]

    assert call_keys(calls) == [None, None]


def test_calls_without_native_id_use_a_unique_exact_finite_start() -> None:
    calls = [
        LlmCall(start=Metric.exact(12.5)),
        LlmCall(start=Metric.estimated(13)),
        LlmCall(start=Metric.exact(float("inf"))),
        LlmCall(start=Metric.not_available()),
    ]

    assert call_keys(calls) == ["time:12.5", None, None, None]


def test_a_start_shared_with_any_call_makes_the_time_key_ambiguous() -> None:
    calls = [LlmCall(start=Metric.exact(10)), LlmCall(start=Metric.estimated(10)), LlmCall(start=Metric.exact(11))]

    assert call_keys(calls) == [None, None, "time:11"]


def test_timestamp_key_uses_the_browser_number_spelling() -> None:
    assert timestamp_key(0) == "0"
    assert timestamp_key(1_790_416_804_000) == "1790416804000"
    assert timestamp_key(12.5) == "12.5"
    assert timestamp_key(0.00001) == "0.00001"
    assert timestamp_key(0.0000001) == "1e-7"
    assert timestamp_key(1e21) == "1e+21"


def test_an_empty_native_id_counts_as_missing() -> None:
    assert call_keys([LlmCall(start=Metric.exact(5), call_id="")]) == ["time:5"]


def test_assign_call_keys_stores_each_owners_keys_on_its_calls() -> None:
    first = LlmCall(start=Metric.exact(1), call_id="a")
    second = LlmCall(start=Metric.exact(2))
    other_owner_call = LlmCall(start=Metric.exact(2))
    agent = Node(node_id="agent", kind=NodeKind.AGENT, topic="agent", llm_calls=[other_owner_call])
    turn = Node(node_id="turn", kind=NodeKind.TURN, topic="turn", llm_calls=[first, second], children=[agent])
    root = Node(node_id="root", kind=NodeKind.SESSION, topic="root", children=[turn])

    assign_call_keys(root)

    assert [first.call_key, second.call_key, other_owner_call.call_key] == ["id:a", "time:2", "time:2"]
