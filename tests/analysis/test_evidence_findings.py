from agentprof.analysis.evidence_findings import find_evidence_findings
from agentprof.model import (
    CallEvent,
    CostMetric,
    ExecutionEvent,
    LlmCall,
    Metric,
    Node,
    NodeKind,
    Provenance,
    Tokens,
    ToolCategory,
    ToolInfo,
)


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


def test_long_gap_finding_cites_calls_and_does_not_claim_idle() -> None:
    earlier = LlmCall(start=Metric.exact(0), duration=Metric.exact(100), call_id="first")
    later = LlmCall(start=Metric.exact(300_100), call_id="second")
    turn = Node(node_id="turn", kind=NodeKind.TURN, topic="t", llm_calls=[earlier, later])
    root = Node(node_id="root", kind=NodeKind.SESSION, topic="s", children=[turn])

    findings = find_evidence_findings(root)
    gap = next(finding for finding in findings if finding.heuristic_id == "E6")

    assert gap.evidence["gap_ms"] == 300_000
    assert gap.evidence["provenance"] == "exact"
    assert gap.evidence["basis"] == "previous_end"
    assert "idle" not in gap.message.casefold()
    assert {reference.key for reference in gap.references} == {"id:first", "id:second"}


def test_cache_rewrite_observed_cost_requires_both_cache_write_parts() -> None:
    call = LlmCall(
        start=Metric.exact(700_000),
        call_id="call-2",
        tokens=Tokens(cache_write=Metric.exact(100_000), cache_read=Metric.exact(100)),
        cost_parts={
            "cache_write_5m": CostMetric(value=2.0, unit="USD", provenance=Provenance.EXACT),
            "cache_write_1h": CostMetric(value=3.0, unit="USD", provenance=Provenance.EXACT),
        },
        gap=Metric.estimated(600_000),
        cold_rewrite=True,
    )
    turn = Node(node_id="turn", kind=NodeKind.TURN, topic="t", llm_calls=[call])
    root = Node(node_id="root", kind=NodeKind.SESSION, topic="s", children=[turn])

    finding = find_evidence_findings(root)[0]

    assert finding.observed_cost.value == 5.0
    assert finding.observed_cost.provenance is Provenance.EXACT
    assert finding.avoidable_cost_baseline is None


def test_compaction_finding_uses_owned_compaction_event_once() -> None:
    earlier = LlmCall(start=Metric.exact(0), duration=Metric.exact(10), call_id="first")
    later = LlmCall(start=Metric.exact(100), call_id="second")
    turn = Node(
        node_id="turn",
        kind=NodeKind.TURN,
        topic="t",
        llm_calls=[earlier, later],
        compactions=[Metric.exact(50)],
        execution_events=[ExecutionEvent(kind="compaction", event_id="compact-1", start=Metric.exact(50))],
    )
    root = Node(
        node_id="root",
        kind=NodeKind.SESSION,
        topic="s",
        compactions=[Metric.exact(50)],
        children=[turn],
    )

    findings = find_evidence_findings(root)
    compactions = [finding for finding in findings if finding.heuristic_id == "E7"]

    assert len(compactions) == 1
    assert compactions[0].node_id == "turn"
    assert compactions[0].evidence["provenance"] == "exact"
    assert {reference.key for reference in compactions[0].references} == {
        "id:first",
        "id:second",
        "compact-1",
    }


def test_estimated_compaction_at_call_start_references_both_adjacent_calls() -> None:
    earlier = LlmCall(start=Metric.exact(0), duration=Metric.exact(10), call_id="first")
    later = LlmCall(start=Metric.exact(100), call_id="second")
    turn = Node(
        node_id="turn",
        kind=NodeKind.TURN,
        topic="t",
        llm_calls=[earlier, later],
        compactions=[Metric.estimated(100)],
    )
    root = Node(node_id="root", kind=NodeKind.SESSION, topic="s", children=[turn])

    finding = next(finding for finding in find_evidence_findings(root) if finding.heuristic_id == "E7")

    assert finding.evidence["earlier_call_id"] == "first"
    assert finding.evidence["later_call_id"] == "second"
    assert {reference.key for reference in finding.references} == {"id:first", "id:second"}
    assert finding.evidence["provenance"] == "estimated"


def test_resume_event_uses_neutral_finding_message() -> None:
    resume = ExecutionEvent(kind="resume", event_id="resume-1", start=Metric.exact(50))
    agent = Node(node_id="agent", kind=NodeKind.AGENT, topic="worker", execution_events=[resume])
    root = Node(node_id="root", kind=NodeKind.SESSION, topic="s", children=[agent])

    finding = next(finding for finding in find_evidence_findings(root) if finding.heuristic_id == "E5")

    assert finding.message == "Agent resume recorded"
    assert finding.references[0].key == "resume-1"
