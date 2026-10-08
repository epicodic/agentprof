# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import pytest

from agentprof import model
from agentprof.adapters.base import AdapterConfig
from agentprof.model import (
    CostMetric,
    Diagnostics,
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
    context_size,
    iter_nodes,
    worst_provenance,
)


def test_metric_factories_set_value_and_provenance() -> None:
    assert Metric.exact(42) == Metric(value=42, provenance=Provenance.EXACT)
    assert Metric.estimated(1.5) == Metric(value=1.5, provenance=Provenance.ESTIMATED)
    assert Metric.not_available() == Metric(value=None, provenance=Provenance.NOT_AVAILABLE)


def test_metric_number_returns_the_value_as_float() -> None:
    assert Metric.exact(3).number() == 3.0


def test_metric_number_raises_when_not_available() -> None:
    with pytest.raises(ValueError, match="not available"):
        Metric.not_available().number()


def test_worst_provenance_prefers_the_least_trustworthy() -> None:
    assert worst_provenance(Provenance.EXACT, Provenance.ESTIMATED) is Provenance.ESTIMATED
    assert worst_provenance(Provenance.ESTIMATED, Provenance.NOT_AVAILABLE) is Provenance.NOT_AVAILABLE
    assert worst_provenance() is Provenance.EXACT


def test_cost_metric_not_available_has_no_value_and_no_unit() -> None:
    assert CostMetric.not_available() == CostMetric(value=None, unit=None, provenance=Provenance.NOT_AVAILABLE)


def test_tokens_default_to_not_available() -> None:
    tokens = Tokens()
    assert [tokens.input, tokens.output, tokens.cache_read, tokens.cache_write] == [Metric.not_available()] * 4


def test_llm_call_defaults_duration_and_tokens_to_not_available() -> None:
    call = LlmCall(start=Metric.exact(10))
    assert call.duration == Metric.not_available()
    assert call.tokens == Tokens()


def test_execution_metadata_keeps_missing_values_unavailable() -> None:
    assert hasattr(model, "EventCallLink")
    assert hasattr(model, "ExecutionEvent")
    event = model.ExecutionEvent(kind="tool_result", event_id="tool-result:t1")
    link = model.EventCallLink(source_request_id="m1", relation="requested_by", evidence="recorded")
    call = LlmCall(start=Metric.exact(100))

    assert event.start == Metric.not_available()
    assert event.subject_node_id is None
    assert event.links == []
    assert link.owner_id is None
    assert call.call_id is None
    assert call.source_request_id is None
    assert call.timing_basis == "unknown"


def test_execution_metadata_mutable_defaults_are_independent() -> None:
    first_event = model.ExecutionEvent(kind="tool_start")
    second_event = model.ExecutionEvent(kind="tool_start")
    first_node = Node(node_id="n1", kind=NodeKind.AGENT, topic="first")
    second_node = Node(node_id="n2", kind=NodeKind.AGENT, topic="second")

    first_event.links.append(model.EventCallLink(source_request_id="m1", relation="requested_by", evidence="recorded"))
    first_node.execution_events.append(first_event)

    assert second_event.links == []
    assert second_node.execution_events == []


def test_recorded_empty_result_event_is_distinct_from_absent_result_metadata() -> None:
    recorded_result = model.ExecutionEvent(kind="tool_result", event_id="tool-result:t1")
    owner_with_recorded_result = Node(
        node_id="owner", kind=NodeKind.AGENT, topic="owner", execution_events=[recorded_result]
    )
    owner_without_result_metadata = Node(node_id="owner", kind=NodeKind.AGENT, topic="owner")

    assert owner_with_recorded_result.execution_events == [recorded_result]
    assert owner_with_recorded_result.execution_events != owner_without_result_metadata.execution_events


def test_node_defaults() -> None:
    node = Node(node_id="n1", kind=NodeKind.TOOL, topic="read")
    assert node.children == []
    assert node.findings == []
    assert node.llm_calls == []
    assert node.tool is None
    assert node.tokens == Tokens()
    assert node.cost_total == CostMetric.not_available()
    assert node.start == Metric.not_available()


def test_tool_info_keeps_raw_arguments_next_to_normalised_ones() -> None:
    info = ToolInfo(
        native_id="read_file",
        category=ToolCategory.READ,
        path="foo.py",
        line_range=(1, 10),
        arguments={"filePath": "foo.py"},
    )
    assert info.command is None
    assert info.arguments == {"filePath": "foo.py"}


def test_tool_info_paths_default_to_the_single_path() -> None:
    assert ToolInfo(native_id="Edit", category=ToolCategory.EDIT, path="a.py").paths == ("a.py",)
    assert ToolInfo(native_id="Edit", category=ToolCategory.EDIT).paths == ()


def test_session_exposes_the_root_span() -> None:
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", start=Metric.exact(1000), end=Metric.exact(5000))
    session = Session(id="copilot-vscode:abc", agent="copilot-vscode", title="t", workspace=None, root=root)
    assert session.start == Metric.exact(1000)
    assert session.end == Metric.exact(5000)
    assert session.sources == []
    assert session.diagnostics == Diagnostics()


def test_iter_nodes_yields_root_then_descendants_depth_first() -> None:
    leaf = Node(node_id="leaf", kind=NodeKind.TOOL, topic="t")
    agent = Node(node_id="agent", kind=NodeKind.AGENT, topic="a", children=[leaf])
    sibling = Node(node_id="sibling", kind=NodeKind.TOOL, topic="t")
    root = Node(node_id="root", kind=NodeKind.TURN, topic="r", children=[agent, sibling])
    assert [n.node_id for n in iter_nodes(root)] == ["root", "agent", "leaf", "sibling"]


def test_finding_records_heuristic_and_evidence() -> None:
    finding = Finding(heuristic_id="W6", node_id="n1", severity="medium", message="idle", evidence={"gap_ms": 192000})
    assert finding.heuristic_id == "W6"
    assert finding.evidence["gap_ms"] == 192000


def test_llm_call_defaults_model_and_cost_to_unknown() -> None:
    call = LlmCall(start=Metric.exact(10))
    assert call.model is None
    assert call.cost == CostMetric.not_available()


def test_node_defaults_tokens_total_to_not_available() -> None:
    assert Node(node_id="n1", kind=NodeKind.TOOL, topic="t").tokens_total == Tokens()


def test_adapter_config_defaults_to_the_bundled_price_table() -> None:
    assert AdapterConfig().pricing_file is None


def test_context_size_adds_input_and_cache_tokens() -> None:
    tokens = Tokens(
        input=Metric.exact(10), output=Metric.exact(99), cache_read=Metric.exact(1000), cache_write=Metric.exact(500)
    )

    assert context_size(tokens) == Metric.exact(1510)


def test_context_size_ignores_missing_parts_and_is_not_available_without_any() -> None:
    assert context_size(Tokens(input=Metric.exact(10), cache_read=Metric.estimated(5))) == Metric.estimated(15)
    assert context_size(Tokens(output=Metric.exact(3))) == Metric.not_available()


def test_context_fields_default_to_empty() -> None:
    node = Node(node_id="n", kind=NodeKind.TURN, topic="t")

    assert node.context_peak == Metric.not_available()
    assert node.compactions == []


def test_llm_calls_are_in_context_by_default() -> None:
    assert LlmCall(start=Metric.exact(0)).in_context


def test_cost_converts_to_usd_with_its_rate() -> None:
    credits = CostMetric(value=42.0, unit="credits", provenance=Provenance.EXACT, usd_per_unit=0.01)

    assert credits.usd == pytest.approx(0.42)
    assert CostMetric(value=3.5, unit="USD", provenance=Provenance.ESTIMATED).usd == 3.5


def test_cost_without_value_or_rate_has_no_usd() -> None:
    assert CostMetric.not_available().usd is None
    assert CostMetric(value=1.0, unit="credits", provenance=Provenance.EXACT).usd is None
