# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from pathlib import Path

from agentprof.adapters.base import SessionRef, SessionSummary
from agentprof.analysis.rollup import roll_up
from agentprof.model import (
    CostMetric,
    EventCallLink,
    ExecutionEvent,
    Finding,
    LlmCall,
    Metric,
    Node,
    NodeKind,
    Provenance,
    Session,
    Tokens,
    ToolCategory,
    ToolInfo,
)
from agentprof.registry import SessionRow
from agentprof.server.schemas import (
    LlmCallOut,
    activity_flags,
    cost_out,
    node_detail_out,
    node_out,
    session_out,
    summary_out,
)

_REF = SessionRef(agent="claude-code", native_id="s1", path=Path("/s1.jsonl"), mtime=100.0)


def _session() -> Session:
    tool = Node(
        node_id="tool1",
        kind=NodeKind.TOOL,
        topic="Read: a.py",
        result="file text",
        tool=ToolInfo(
            native_id="Read",
            category=ToolCategory.READ,
            path="a.py",
            line_range=(1, 5),
            arguments={"file_path": "a.py"},
        ),
        start=Metric.exact(10),
    )
    call = LlmCall(
        start=Metric.exact(5),
        model="claude-sonnet-5",
        tokens=Tokens(input=Metric.exact(3)),
        cost=CostMetric(value=0.25, unit="USD", provenance=Provenance.ESTIMATED),
    )
    finding = Finding(heuristic_id="W6", node_id="t1", severity="low", message="idle", evidence={"gap_ms": 5})
    turn = Node(
        node_id="t1",
        kind=NodeKind.TURN,
        topic="Fix it",
        prompt="Fix it please",
        children=[tool],
        llm_calls=[call],
        findings=[finding],
    )
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[turn])
    return Session(
        id="claude-code:s1", agent="claude-code", title="Fix it", workspace="/repo", root=root, sources=["transcript"]
    )


def test_session_out_maps_the_tree_without_texts() -> None:
    out = session_out(_session(), 100.0).model_dump()

    turn = out["root"]["children"][0]
    assert out["id"] == "claude-code:s1"
    assert out["mtime"] == 100.0
    assert turn["kind"] == "turn"
    assert "prompt" not in turn
    assert turn["llm_calls"][0]["cost"] == {"value": 0.25, "unit": "USD", "usd": 0.25, "provenance": "estimated"}
    assert turn["findings"][0]["evidence"] == {"gap_ms": 5}
    tool = turn["children"][0]
    assert tool["tool"] == {
        "native_id": "Read",
        "category": "read",
        "path": "a.py",
        "paths": ["a.py"],
        "line_range": (1, 5),
        "command": None,
        "writes_file": False,
        "target_agent_id": None,
        "is_resume": False,
        "linked_agent_node_id": None,
    }
    assert tool["start"] == {"value": 10, "provenance": "exact"}
    assert "arguments" not in tool["tool"]


def test_session_out_maps_execution_snapshots_without_bodies() -> None:
    call = LlmCall(
        start=Metric.not_available(),
        source_request_id="req-1",
        source_order=4,
        source_stream_id="stream-1",
        timing_basis="usage_report",
    )
    event = ExecutionEvent(
        kind="tool_result",
        event_id="result-1",
        subject_node_id="tool1",
        source_order=5,
        source_stream_id="stream-1",
        links=[EventCallLink("req-1", "requested_by", "recorded")],
        execution_start=Metric.exact(10),
        execution_end=Metric.estimated(13),
    )
    tool = Node(
        node_id="tool1",
        kind=NodeKind.TOOL,
        topic="secret tool summary",
        prompt="secret prompt",
        result="secret result",
        tool=ToolInfo(native_id="Read", category=ToolCategory.READ),
        execution_events=[event],
    )
    turn = Node(node_id="t1", kind=NodeKind.TURN, topic="turn", llm_calls=[call], children=[tool])
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="session", children=[turn])
    output = session_out(
        Session(id="claude-code:s1", agent="claude-code", title="s", workspace=None, root=root), 1.0
    ).model_dump()

    call_out = output["root"]["children"][0]["llm_calls"][0]
    event_out = output["root"]["children"][0]["children"][0]["execution_events"][0]
    assert call_out["source_request_id"] == "req-1"
    assert call_out["start"] == {"value": None, "provenance": "n/a"}
    assert event_out["execution_start"] == {"value": 10, "provenance": "exact"}
    assert event_out["execution_end"] == {"value": 13, "provenance": "estimated"}
    assert event_out["links"][0]["owner_id"] is None
    assert "secret prompt" not in str(output)
    assert "secret result" not in str(output)
    assert "secret tool summary" not in str(event_out)


def test_session_out_keeps_duplicate_id_event_links_unresolved() -> None:
    first = LlmCall(start=Metric.exact(1), source_request_id="duplicate")
    second = LlmCall(start=Metric.exact(2), source_request_id="duplicate")
    event = ExecutionEvent(kind="message", links=[EventCallLink("duplicate", "requested_by", "recorded")])
    turn = Node(node_id="turn", kind=NodeKind.TURN, topic="turn", llm_calls=[first, second], execution_events=[event])
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[turn])

    event_out = (
        session_out(Session(id="claude-code:s1", agent="claude-code", title="s", workspace=None, root=root), 1.0)
        .root.children[0]
        .execution_events[0]
    )

    assert event_out.links[0].owner_id is None


def test_llm_call_timing_basis_schema_has_the_model_literal_values() -> None:
    timing_basis = LlmCallOut.model_json_schema()["properties"]["timing_basis"]

    assert timing_basis["enum"] == ["request_start", "assistant_message", "usage_report", "turn_start", "unknown"]


def test_session_out_marks_started_nodes_without_an_end_as_active() -> None:
    active = Node(node_id="active", kind=NodeKind.TOOL, topic="active", start=Metric.exact(1))
    finished = Node(
        node_id="finished",
        kind=NodeKind.TOOL,
        topic="finished",
        start=Metric.exact(1),
        end=Metric.exact(2),
    )
    unseen = Node(node_id="unseen", kind=NodeKind.TOOL, topic="unseen")
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[active, finished, unseen])
    session = Session(id="claude-code:s1", agent="claude-code", title="Fix it", workspace="/repo", root=root)

    children = session_out(session, 100.0).root.children

    assert [child.active for child in children] == [True, False, False]


def test_bounded_node_keeps_activity_from_omitted_descendants() -> None:
    active = Node(node_id="agent", kind=NodeKind.AGENT, topic="agent", start=Metric.exact(10))
    root = Node(node_id="root", kind=NodeKind.SESSION, topic="s", children=[active])

    output = node_out(root, max_depth=0, activity_flags=activity_flags(root, None))

    assert output.children == []
    assert output.active_descendant is True


def test_session_out_marks_started_nodes_with_an_estimated_end_as_active() -> None:
    active = Node(
        node_id="active",
        kind=NodeKind.TURN,
        topic="active",
        start=Metric.exact(1),
        end=Metric.estimated(2),
    )
    session = Session(
        id="codex:s1",
        agent="codex",
        title="active turn",
        workspace="/repo",
        root=Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[active]),
    )

    turn = session_out(session, 100.0).root.children[0]

    assert turn.active is True


def test_session_out_marks_a_turn_with_an_inferred_timeline_end_as_active() -> None:
    turn = Node(
        node_id="active",
        kind=NodeKind.TURN,
        topic="active",
        start=Metric.exact(1),
        children=[Node(node_id="tool", kind=NodeKind.TOOL, topic="tool", start=Metric.exact(2), end=Metric.exact(3))],
    )
    roll_up(turn)
    session = Session(
        id="codex:s1",
        agent="codex",
        title="active turn",
        workspace="/repo",
        root=Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[turn]),
    )

    out = session_out(session, 100.0).root.children[0]

    assert out.end.value == 3
    assert out.end.provenance == "estimated"
    assert out.active is True

    roll_up(session.root)
    root = session_out(session, 100.0).root
    assert root.active is False
    assert root.active_descendant is True


def test_session_out_marks_ancestors_of_active_nodes_as_active() -> None:
    active_agent = Node(node_id="agent", kind=NodeKind.AGENT, topic="active", start=Metric.exact(1))
    finished_turn = Node(
        node_id="turn",
        kind=NodeKind.TURN,
        topic="finished own span",
        start=Metric.exact(0),
        end=Metric.exact(2),
        children=[active_agent],
    )
    root = Node(
        node_id="session",
        kind=NodeKind.SESSION,
        topic="s",
        start=Metric.exact(0),
        end=Metric.exact(2),
        children=[finished_turn],
    )
    session = Session(id="claude-code:s1", agent="claude-code", title="Fix it", workspace="/repo", root=root)

    out = session_out(session, 100.0).root

    assert out.active is False
    assert out.active_descendant is True
    assert out.children[0].active is False
    assert out.children[0].active_descendant is True
    assert out.children[0].children[0].active is True
    assert out.children[0].children[0].active_descendant is False


def test_session_out_labels_running_agents_and_waiting_ancestors() -> None:
    running_agent = Node(node_id="agent", kind=NodeKind.AGENT, topic="running", start=Metric.exact(1))
    waiting_turn = Node(
        node_id="turn",
        kind=NodeKind.TURN,
        topic="waiting",
        start=Metric.exact(0),
        end=Metric.exact(2),
        children=[running_agent],
    )
    finished_turn = Node(
        node_id="finished", kind=NodeKind.TURN, topic="finished", start=Metric.exact(3), end=Metric.exact(4)
    )
    session = Session(
        id="claude-code:s1",
        agent="claude-code",
        title="Fix it",
        workspace="/repo",
        root=Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[waiting_turn, finished_turn]),
    )

    waiting, finished = session_out(session, 100.0).root.children

    assert waiting.activity == "waiting"
    assert waiting.children[0].activity == "running"
    assert finished.activity is None


def test_session_out_does_not_mark_finished_agent_active_for_an_open_tool() -> None:
    open_tool = Node(node_id="tool", kind=NodeKind.TOOL, topic="open record", start=Metric.exact(1))
    finished_agent = Node(
        node_id="agent",
        kind=NodeKind.AGENT,
        topic="finished",
        start=Metric.exact(0),
        end=Metric.exact(2),
        children=[open_tool],
    )
    session = Session(
        id="claude-code:s1",
        agent="claude-code",
        title="Fix it",
        workspace="/repo",
        root=Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[finished_agent]),
    )

    agent = session_out(session, 100.0).root.children[0]

    assert agent.active is False
    assert agent.active_descendant is False


def test_session_out_does_not_mark_an_earlier_turn_active_once_a_later_turn_has_progressed() -> None:
    """An estimated end only means "active" when it is the most recent known activity in the session."""
    earlier_turn = Node(
        node_id="earlier",
        kind=NodeKind.TURN,
        topic="earlier",
        start=Metric.exact(0),
        children=[Node(node_id="tool-a", kind=NodeKind.TOOL, topic="a", start=Metric.exact(1), end=Metric.exact(100))],
    )
    later_turn = Node(
        node_id="later",
        kind=NodeKind.TURN,
        topic="later",
        start=Metric.exact(200),
        children=[
            Node(node_id="tool-b", kind=NodeKind.TOOL, topic="b", start=Metric.exact(201), end=Metric.exact(300))
        ],
    )
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[earlier_turn, later_turn])
    roll_up(root)
    session = Session(id="codex:s1", agent="codex", title="t", workspace="/repo", root=root)

    out = session_out(session, 100.0).root.children

    assert out[0].end.value == 100
    assert out[0].active is False
    assert out[1].end.value == 300
    assert out[1].active is True


def test_session_out_marks_a_finished_turn_active_for_a_sub_agent_nested_under_a_tool() -> None:
    """`active_descendant` must see through intermediate tool nodes to a nested sub-agent."""
    nested_agent = Node(node_id="agent", kind=NodeKind.AGENT, topic="active", start=Metric.exact(2))
    tool_wrapper = Node(
        node_id="tool", kind=NodeKind.TOOL, topic="wrapper", start=Metric.exact(1), children=[nested_agent]
    )
    turn = Node(
        node_id="turn",
        kind=NodeKind.TURN,
        topic="finished own span",
        start=Metric.exact(0),
        end=Metric.exact(10),
        children=[tool_wrapper],
    )
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[turn])
    session = Session(id="claude-code:s1", agent="claude-code", title="Fix it", workspace="/repo", root=root)

    out = session_out(session, 100.0).root.children[0]

    assert out.active is False
    assert out.active_descendant is True


def test_session_out_assigns_chronological_agent_ids() -> None:
    earliest = Node(
        node_id="spawning-tool-early",
        agent_uuid="agent-uuid-early",
        kind=NodeKind.AGENT,
        topic="early",
        start=Metric.exact(10),
    )
    latest = Node(
        node_id="spawning-tool-late",
        agent_uuid="agent-uuid-late",
        kind=NodeKind.AGENT,
        topic="late",
        start=Metric.exact(30),
    )
    resumed = Node(
        node_id="spawning-tool-resumed",
        agent_uuid="agent-uuid-early",
        kind=NodeKind.AGENT,
        topic="resumed early",
        start=Metric.exact(40),
    )
    root = Node(
        node_id="session",
        kind=NodeKind.SESSION,
        topic="s",
        children=[
            Node(
                node_id="turn",
                kind=NodeKind.TURN,
                topic="prompt",
                children=[latest, earliest, resumed],
            )
        ],
    )
    session = Session(id="claude-code:s1", agent="claude-code", title="Fix it", workspace="/repo", root=root)

    out = session_out(session, 100.0).model_dump()["root"]
    turn = out["children"][0]

    assert out["agent_id"] == 1
    assert turn["agent_id"] == 1
    assert turn["children"][0]["agent_id"] == 3
    assert turn["children"][1]["agent_id"] == 2
    assert turn["children"][2]["agent_id"] == 2


def test_session_out_uses_source_order_when_agent_timestamps_are_unavailable() -> None:
    unknown_time = Node(
        node_id="spawning-tool-unknown",
        kind=NodeKind.AGENT,
        topic="unknown",
    )
    known_time = Node(
        node_id="spawning-tool-known",
        agent_uuid="agent-uuid-known",
        kind=NodeKind.AGENT,
        topic="known",
        start=Metric.exact(10),
    )
    root = Node(
        node_id="session",
        kind=NodeKind.SESSION,
        topic="s",
        children=[unknown_time, known_time],
    )
    session = Session(id="claude-code:s1", agent="claude-code", title="Fix it", workspace="/repo", root=root)

    children = session_out(session, 100.0).root.children

    assert [child.agent_id for child in children] == [2, 3]


def test_session_out_assigns_each_node_its_owning_agent_id() -> None:
    subagent_tool = Node(node_id="subagent-tool", kind=NodeKind.TOOL, topic="subagent tool")
    subagent = Node(
        node_id="spawning-tool",
        agent_uuid="agent-uuid",
        kind=NodeKind.AGENT,
        topic="subagent",
        children=[subagent_tool],
    )
    root_tool = Node(node_id="root-tool", kind=NodeKind.TOOL, topic="root tool")
    turn = Node(node_id="turn", kind=NodeKind.TURN, topic="prompt", children=[root_tool, subagent])
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[turn])
    session = Session(id="claude-code:s1", agent="claude-code", title="Fix it", workspace="/repo", root=root)

    out = session_out(session, 100.0).root

    assert out.agent_id == 1
    assert out.children[0].agent_id == 1
    assert out.children[0].children[0].agent_id == 1
    assert out.children[0].children[1].agent_id == 2
    assert out.children[0].children[1].children[0].agent_id == 2


def test_node_detail_out_carries_texts_and_arguments() -> None:
    session = _session()
    tool = session.root.children[0].children[0]

    detail = node_detail_out(tool).model_dump()

    assert detail == {"node_id": "tool1", "prompt": "", "result": "file text", "arguments": {"file_path": "a.py"}}


def test_summary_out_of_a_pending_row_falls_back_to_the_native_id() -> None:
    out = summary_out(SessionRow(ref=_REF)).model_dump()

    assert out["id"] == "claude-code:s1"
    assert out["title"] == "s1"
    assert out["state"] == "pending"
    assert out["cost_total"] is None
    assert out["last_activity_ms"] is None


def test_summary_out_carries_the_summary() -> None:
    summary = SessionSummary(
        id=_REF.id,
        agent="claude-code",
        title="Fix it",
        workspace="/repo",
        start_ms=1,
        end_ms=2,
        last_activity_ms=1.5,
        file_size=3,
        cost_total=CostMetric(value=1.5, unit="USD", provenance=Provenance.ESTIMATED),
    )
    row = SessionRow(ref=_REF, summary=summary, summarized_mtime=100.0)

    out = summary_out(row).model_dump()

    assert (out["title"], out["state"], out["workspace"]) == ("Fix it", "summarized", "/repo")
    assert out["last_activity_ms"] == 1.5
    assert out["cost_total"] == {"value": 1.5, "unit": "USD", "usd": 1.5, "provenance": "estimated"}
    assert out["error"] is None


def test_summary_out_shows_the_error_of_an_error_row_only() -> None:
    failed = SessionRow(ref=_REF, error="ValueError: bad", failed_mtime=100.0)
    recovered = SessionRow(ref=_REF, error="ValueError: bad", failed_mtime=50.0)

    assert summary_out(failed).error == "ValueError: bad"
    assert summary_out(recovered).error is None


def test_session_out_carries_context_fields() -> None:
    session = _session()
    turn = session.root.children[0]
    turn.context_peak = Metric.exact(3)
    turn.compactions = [Metric.exact(7)]

    out = session_out(session, 100.0).model_dump()["root"]["children"][0]

    assert out["context_peak"] == {"value": 3, "provenance": "exact"}
    assert out["compactions"] == [{"value": 7, "provenance": "exact"}]


def test_cost_out_adds_the_usd_value_of_credits() -> None:
    cost = CostMetric(value=42.0, unit="credits", provenance=Provenance.EXACT, usd_per_unit=0.01)

    assert cost_out(cost).model_dump() == {"value": 42.0, "unit": "credits", "usd": 0.42, "provenance": "exact"}
