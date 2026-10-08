# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Invariants every adapter's analysed sessions must satisfy."""

import shutil
from pathlib import Path

import pytest

from agentprof.adapters.base import AdapterConfig, AgentAdapter, SessionRef
from agentprof.adapters.claude_code.adapter import ClaudeCodeAdapter
from agentprof.adapters.codex.adapter import CodexAdapter
from agentprof.adapters.copilot_vscode.adapter import CopilotVscodeAdapter
from agentprof.analysis.pipeline import analyze
from agentprof.model import CostMetric, Metric, Node, Provenance, Session, iter_nodes

_COPILOT_FIXTURES = Path(__file__).parent / "adapters" / "copilot_vscode" / "fixtures"
_CLAUDE_PROJECTS = Path(__file__).parent / "adapters" / "claude_code" / "fixtures" / "projects"
_CODEX_SESSIONS = Path(__file__).parent / "adapters" / "codex" / "fixtures" / "sessions"
_TOKEN_FIELDS = ("input", "output", "cache_read", "cache_write")


def _copilot_live(copilot_storage: Path, tmp_path: Path) -> tuple[AgentAdapter, SessionRef]:
    adapter = CopilotVscodeAdapter(AdapterConfig(roots={"copilot-vscode": copilot_storage}))
    (ref,) = adapter.discover()
    return adapter, ref


def _copilot_export(copilot_storage: Path, tmp_path: Path) -> tuple[AgentAdapter, SessionRef]:
    adapter = CopilotVscodeAdapter(AdapterConfig(roots={"copilot-vscode": copilot_storage}))
    export = tmp_path / "export.json"
    shutil.copy(_COPILOT_FIXTURES / "export_basic.json", export)
    ref = adapter.open_path(export)
    assert ref is not None
    return adapter, ref


def _claude_code(copilot_storage: Path, tmp_path: Path) -> tuple[AgentAdapter, SessionRef]:
    adapter = ClaudeCodeAdapter(AdapterConfig(roots={"claude-code": _CLAUDE_PROJECTS}))
    (ref,) = adapter.discover()
    return adapter, ref


def _codex(copilot_storage: Path, tmp_path: Path) -> tuple[AgentAdapter, SessionRef]:
    adapter = CodexAdapter(AdapterConfig(roots={"codex": _CODEX_SESSIONS}))
    (ref,) = adapter.discover()
    return adapter, ref


_CASES = {
    "copilot-live": _copilot_live,
    "copilot-export": _copilot_export,
    "claude-code": _claude_code,
    "codex": _codex,
}


@pytest.fixture(params=sorted(_CASES))
def source(request: pytest.FixtureRequest, copilot_storage: Path, tmp_path: Path) -> tuple[AgentAdapter, SessionRef]:
    return _CASES[request.param](copilot_storage, tmp_path)


@pytest.fixture
def session(source: tuple[AgentAdapter, SessionRef]) -> Session:
    return analyze(*source)


def test_summary_cost_matches_the_analysed_total(source: tuple[AgentAdapter, SessionRef]) -> None:
    adapter, ref = source

    summary_cost = adapter.summarize(ref).cost_total
    analysed_cost = analyze(adapter, ref).root.cost_total

    assert summary_cost.value is not None
    assert summary_cost.value == pytest.approx(analysed_cost.value)
    assert (summary_cost.unit, summary_cost.provenance) == (analysed_cost.unit, analysed_cost.provenance)
    assert summary_cost.usd == pytest.approx(analysed_cost.usd)


def _metrics(node: Node) -> list[Metric]:
    return [
        node.start,
        node.end,
        node.duration,
        node.user_wait,
        node.llm_call_count,
        node.tool_call_count,
        *(getattr(tokens, name) for tokens in (node.tokens, node.tokens_total) for name in _TOKEN_FIELDS),
        *(call.start for call in node.llm_calls),
        *(call.duration for call in node.llm_calls),
        *(getattr(call.tokens, name) for call in node.llm_calls for name in _TOKEN_FIELDS),
    ]


def _costs(node: Node) -> list[CostMetric]:
    return [node.cost_total, node.cost_own, *(call.cost for call in node.llm_calls)]


def test_session_id_is_prefixed_with_the_adapter_name(session: Session) -> None:
    assert session.id.startswith(f"{session.agent}:")


def test_node_ids_are_unique(session: Session) -> None:
    node_ids = [node.node_id for node in iter_nodes(session.root)]
    assert len(node_ids) == len(set(node_ids))


def test_tree_has_no_shared_or_cyclic_nodes(session: Session) -> None:
    seen: set[int] = set()
    for node in iter_nodes(session.root):
        assert id(node) not in seen
        seen.add(id(node))


def test_every_metric_has_a_consistent_provenance(session: Session) -> None:
    for node in iter_nodes(session.root):
        for metric in _metrics(node):
            assert (metric.value is None) == (metric.provenance is Provenance.NOT_AVAILABLE)


def test_own_cost_never_exceeds_total_cost(session: Session) -> None:
    for node in iter_nodes(session.root):
        own, total = node.cost_own.value, node.cost_total.value
        if own is not None and total is not None:
            assert own <= total
            assert node.cost_own.unit == node.cost_total.unit


def test_findings_reference_their_own_node(session: Session) -> None:
    for node in iter_nodes(session.root):
        assert all(finding.node_id == node.node_id for finding in node.findings)


def test_every_cost_has_a_consistent_provenance_and_unit(session: Session) -> None:
    for node in iter_nodes(session.root):
        for cost in _costs(node):
            assert (cost.value is None) == (cost.provenance is Provenance.NOT_AVAILABLE)
            assert (cost.value is None) == (cost.unit is None)


def test_costs_and_counts_are_never_negative(session: Session) -> None:
    for node in iter_nodes(session.root):
        assert all(cost.value is None or cost.value >= 0 for cost in _costs(node))
        assert all(metric.value is None or metric.value >= 0 for metric in _metrics(node))
