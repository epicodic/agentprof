# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from agentprof.analysis.execution import resolve_execution_links
from agentprof.model import EventCallLink, ExecutionEvent, LlmCall, Metric, Node, NodeKind


def test_links_resolve_across_main_turns_but_not_into_children() -> None:
    call = LlmCall(start=Metric.exact(10), source_request_id="m1")
    event = ExecutionEvent(
        kind="tool_result",
        event_id="tool-result:t1",
        links=[EventCallLink(source_request_id="m1", relation="requested_by", evidence="recorded")],
    )
    first = Node(node_id="u1", kind=NodeKind.TURN, topic="first", llm_calls=[call])
    child = Node(
        node_id="a1",
        kind=NodeKind.AGENT,
        topic="child",
        llm_calls=[LlmCall(start=Metric.exact(11), source_request_id="m1")],
    )
    second = Node(node_id="u2", kind=NodeKind.TURN, topic="second", children=[child], execution_events=[event])
    root = Node(node_id="s", kind=NodeKind.SESSION, topic="session", children=[first, second])

    resolve_execution_links(root)

    assert event.links[0].owner_id == "u1"


def test_links_resolve_in_retained_subagent_stream_and_node_scoped_fallback() -> None:
    retained = Node(
        node_id="agent1",
        kind=NodeKind.AGENT,
        topic="retained",
        agent_uuid="harness-1",
        llm_calls=[LlmCall(start=Metric.exact(1), source_request_id="same")],
    )
    retained_event = ExecutionEvent(
        kind="tool_result",
        links=[EventCallLink("same", "requested_by", "recorded")],
    )
    retained.execution_events.append(retained_event)
    resumed = Node(
        node_id="agent2",
        kind=NodeKind.AGENT,
        topic="resumed",
        agent_uuid="harness-1",
        llm_calls=[LlmCall(start=Metric.exact(2), source_request_id="same")],
    )
    fallback = Node(
        node_id="fallback",
        kind=NodeKind.AGENT,
        topic="fallback",
        llm_calls=[LlmCall(start=Metric.exact(3), source_request_id="other")],
        execution_events=[
            ExecutionEvent(kind="tool_result", links=[EventCallLink("other", "requested_by", "recorded")])
        ],
    )
    root = Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[retained, resumed, fallback])

    resolve_execution_links(root)

    assert retained_event.links[0].owner_id is None
    assert fallback.execution_events[0].links[0].owner_id == "fallback"


def test_links_require_unique_exact_id_and_valid_evidence_pair() -> None:
    call = LlmCall(start=Metric.not_available(), source_request_id="dup")
    good = ExecutionEvent(
        kind="message",
        links=[EventCallLink("unique", "consumed_by", "recorded", owner_id="stale")],
    )
    invalid = ExecutionEvent(
        kind="message", links=[EventCallLink("unique", "requested_by", "observed_order", owner_id="stale")]
    )
    missing = ExecutionEvent(kind="message", links=[EventCallLink("missing", "requested_by", "recorded")])
    duplicate = ExecutionEvent(kind="message", links=[EventCallLink("dup", "requested_by", "recorded")])
    turn = Node(
        node_id="u1",
        kind=NodeKind.TURN,
        topic="turn",
        llm_calls=[
            call,
            LlmCall(start=Metric.exact(500), source_request_id="dup"),
            LlmCall(start=Metric.exact(500), source_request_id="unique"),
        ],
        execution_events=[good, invalid, missing, duplicate],
    )
    root = Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[turn])

    resolve_execution_links(root)

    assert [event.links[0].owner_id for event in (good, invalid, missing, duplicate)] == ["u1", None, None, None]


def test_root_events_and_root_calls_are_in_main_stream() -> None:
    event = ExecutionEvent(
        kind="completion", links=[EventCallLink("root-call", "next_observed_call", "observed_order")]
    )
    root = Node(
        node_id="s",
        kind=NodeKind.SESSION,
        topic="s",
        llm_calls=[LlmCall(start=Metric.exact(99), source_request_id="root-call")],
        execution_events=[event],
    )

    resolve_execution_links(root)

    assert event.links[0].owner_id == "s"
