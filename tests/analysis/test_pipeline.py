# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from pathlib import Path
from typing import cast

import pytest

from agentprof.adapters.base import AdapterConfig, AgentAdapter, SessionRef
from agentprof.adapters.copilot_vscode.adapter import CopilotVscodeAdapter
from agentprof.analysis.pipeline import analyze, attach_findings
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
)
from agentprof.server.schemas import session_out


def test_analyze_rolls_up_the_adapter_tree(copilot_storage: Path) -> None:
    adapter = CopilotVscodeAdapter(AdapterConfig(roots={"copilot-vscode": copilot_storage}))
    (ref,) = adapter.discover()

    session = analyze(adapter, ref)

    turn = session.root.children[0]
    lead = turn.children[1]
    assert session.start == turn.start
    assert lead.tokens.input == Metric.exact(20000)
    assert turn.cost_own == CostMetric(value=29.5, unit="credits", provenance=Provenance.EXACT, usd_per_unit=0.01)


def test_analyze_keeps_a_rolled_up_end_active() -> None:
    class OpenTurnAdapter:
        name = "test"

        def analyze(self, ref: SessionRef) -> Session:
            completed_tool = Node(
                node_id="tool",
                kind=NodeKind.TOOL,
                topic="completed",
                start=Metric.exact(2),
                end=Metric.exact(3),
            )
            open_turn = Node(
                node_id="turn", kind=NodeKind.TURN, topic="open", start=Metric.exact(1), children=[completed_tool]
            )
            return Session(
                id=ref.id,
                agent=self.name,
                title="open turn",
                workspace=None,
                root=Node(node_id="session", kind=NodeKind.SESSION, topic="session", children=[open_turn]),
            )

    ref = SessionRef(agent="test", native_id="open", path=Path("/open"), mtime=0)

    session = analyze(cast(AgentAdapter, OpenTurnAdapter()), ref)

    turn = session.root.children[0]
    assert turn.end == Metric.estimated(3)
    assert session_out(session, 0).root.children[0].active is True


def test_analyze_resolves_source_links_before_rollup() -> None:
    class SourceLinkAdapter:
        name = "test"

        def analyze(self, ref: SessionRef) -> Session:
            call = LlmCall(start=Metric.exact(1), source_request_id="req")
            event = ExecutionEvent(kind="tool_result", links=[EventCallLink("req", "requested_by", "recorded")])
            turn = Node(node_id="turn", kind=NodeKind.TURN, topic="turn", llm_calls=[call], execution_events=[event])
            root = Node(node_id="session", kind=NodeKind.SESSION, topic="session", children=[turn])
            return Session(id=ref.id, agent=self.name, title="test", workspace=None, root=root)

    ref = SessionRef(agent="test", native_id="link", path=Path("/link"), mtime=0)

    session = analyze(cast(AgentAdapter, SourceLinkAdapter()), ref)

    assert session.root.children[0].execution_events[0].links[0].owner_id == "turn"


def test_attach_findings_appends_each_finding_to_its_node() -> None:
    child = Node(node_id="child", kind=NodeKind.AGENT, topic="c")
    root = Node(node_id="root", kind=NodeKind.TURN, topic="r", children=[child])
    finding = Finding(heuristic_id="W6", node_id="child", severity="low", message="idle")

    attach_findings(root, [finding])

    assert child.findings == [finding]
    assert root.findings == []


def test_attach_findings_rejects_a_finding_for_an_unknown_node() -> None:
    root = Node(node_id="root", kind=NodeKind.TURN, topic="r")
    finding = Finding(heuristic_id="W6", node_id="ghost", severity="low", message="idle")

    with pytest.raises(ValueError, match="unknown node 'ghost'"):
        attach_findings(root, [finding])
