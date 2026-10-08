from agentprof.analysis.evidence_findings import find_evidence_findings
from agentprof.model import CallEvent, LlmCall, Metric, Node, NodeKind, Tokens, ToolCategory, ToolInfo


def test_large_rewrite_finding_uses_measured_call_evidence() -> None:
    call = LlmCall(
        start=Metric.exact(700_000),
        call_id="call-2",
        tokens=Tokens(cache_write=Metric.exact(100_000), cache_read=Metric.exact(100)),
        gap=Metric.estimated(600_000),
        cold_rewrite=True,
    )
    root = Node(
        node_id="root",
        kind=NodeKind.SESSION,
        topic="s",
        children=[Node(node_id="turn", kind=NodeKind.TURN, topic="t", llm_calls=[call])],
    )

    findings = find_evidence_findings(root)

    assert len(findings) == 1
    assert findings[0].heuristic_id == "E1"
    assert findings[0].evidence["call_id"] == "call-2"
    assert findings[0].evidence["cache_write_tokens"] == 100_000
    assert findings[0].evidence["cold_reason"] == "unknown"
    assert findings[0].evidence["provenance"] == "exact"


def test_blocking_wait_after_rewrite_requires_timed_ask_user_tool() -> None:
    call = LlmCall(
        start=Metric.exact(700_000),
        call_id="call-2",
        tokens=Tokens(cache_write=Metric.exact(100_000), cache_read=Metric.exact(100)),
        gap=Metric.estimated(600_000),
        cold_rewrite=True,
        preceding_events=[CallEvent("tool", "ask", Metric.exact(10), Metric.exact(610_000), Metric.exact(600_000))],
    )
    ask = Node(
        node_id="ask",
        kind=NodeKind.TOOL,
        topic="ask",
        tool=ToolInfo(native_id="AskUserQuestion", category=ToolCategory.OTHER),
    )
    turn = Node(node_id="turn", kind=NodeKind.TURN, topic="t", llm_calls=[call], children=[ask])
    root = Node(node_id="root", kind=NodeKind.SESSION, topic="s", children=[turn])

    assert [finding.heuristic_id for finding in find_evidence_findings(root)] == ["E1", "E2"]
    assert find_evidence_findings(root)[1].evidence["tool_node_id"] == "ask"


def test_large_write_without_low_cache_read_is_not_called_cold() -> None:
    call = LlmCall(
        start=Metric.exact(100),
        tokens=Tokens(cache_write=Metric.exact(100_000), cache_read=Metric.exact(100_000)),
    )
    root = Node(node_id="root", kind=NodeKind.SESSION, topic="s", llm_calls=[call])

    assert find_evidence_findings(root) == []


def test_resume_and_parent_idle_are_separate_findings() -> None:
    resume = Node(
        node_id="send",
        kind=NodeKind.TOOL,
        topic="message",
        tool=ToolInfo(
            native_id="SendMessage",
            category=ToolCategory.OTHER,
            target_agent_id="a1",
            is_resume=True,
            linked_agent_node_id="agent",
        ),
    )
    later = LlmCall(
        start=Metric.exact(700_000),
        call_id="later",
        preceding_events=[CallEvent("child_completion", "agent", Metric.exact(100_000), Metric.estimated(100_000))],
    )
    turn = Node(node_id="turn", kind=NodeKind.TURN, topic="t", llm_calls=[later], children=[resume])
    root = Node(node_id="root", kind=NodeKind.SESSION, topic="s", children=[turn])

    assert [finding.heuristic_id for finding in find_evidence_findings(root)] == ["E4", "E5"]
    assert find_evidence_findings(root)[0].evidence["provenance"] == "estimated"


def test_context_growth_requires_large_measured_increase() -> None:
    earlier = LlmCall(start=Metric.exact(1), call_id="a", tokens=Tokens(input=Metric.exact(50_000)))
    later = LlmCall(start=Metric.exact(2), call_id="b", tokens=Tokens(input=Metric.exact(120_000)))
    turn = Node(node_id="turn", kind=NodeKind.TURN, topic="t", llm_calls=[earlier, later])
    root = Node(node_id="root", kind=NodeKind.SESSION, topic="s", children=[turn])

    findings = find_evidence_findings(root)

    assert [finding.heuristic_id for finding in findings] == ["E3"]
    assert findings[0].evidence["earlier_call_id"] == "a"


def test_context_growth_across_turns_includes_cached_tokens() -> None:
    earlier = LlmCall(
        start=Metric.exact(1),
        call_id="a",
        tokens=Tokens(input=Metric.exact(1_000), cache_read=Metric.estimated(49_000)),
    )
    later = LlmCall(
        start=Metric.exact(2), call_id="b", tokens=Tokens(input=Metric.exact(1_000), cache_read=Metric.exact(119_000))
    )
    root = Node(
        node_id="root",
        kind=NodeKind.SESSION,
        topic="s",
        children=[
            Node(node_id="turn-1", kind=NodeKind.TURN, topic="first", llm_calls=[earlier]),
            Node(node_id="turn-2", kind=NodeKind.TURN, topic="second", llm_calls=[later]),
        ],
    )

    findings = find_evidence_findings(root)

    assert [finding.heuristic_id for finding in findings] == ["E3"]
    assert findings[0].node_id == "turn-2"
    assert findings[0].evidence["later_context_tokens"] == 120_000
    assert findings[0].evidence["provenance"] == "estimated"
