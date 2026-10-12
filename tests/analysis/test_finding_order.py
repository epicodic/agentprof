# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from agentprof.analysis.finding_order import ordered_findings, rank_findings
from agentprof.model import CostMetric, Finding, Metric, Node, NodeKind, Provenance


def _finding(heuristic: str, node: str, severity: str, usd: float | None = None, start: float | None = None) -> Finding:
    cost = (
        CostMetric.not_available()
        if usd is None
        else CostMetric(value=usd, unit="USD", provenance=Provenance.ESTIMATED)
    )
    evidence: dict[str, object] = {} if start is None else {"call_start_ms": start}
    return Finding(heuristic, node, severity, "m", evidence=evidence, estimated_avoidable_cost=cost)


def test_findings_order_by_avoidable_cost_then_severity_then_time() -> None:
    cheap = _finding("W1", "a", "high", usd=1)
    costly = _finding("W2", "a", "low", usd=5)
    late_medium = _finding("E3", "b", "medium", start=200)
    early_medium = _finding("E1", "b", "medium", start=100)
    high = _finding("W8", "b", "high")
    first = Node(node_id="a", kind=NodeKind.TURN, topic="a", start=Metric.exact(1), findings=[cheap, costly])
    second = Node(
        node_id="b", kind=NodeKind.TURN, topic="b", start=Metric.exact(2), findings=[late_medium, early_medium, high]
    )
    root = Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[first, second])

    assert ordered_findings(root) == [costly, cheap, high, early_medium, late_medium]


def test_rank_findings_stores_the_position() -> None:
    low = _finding("W1", "a", "low")
    high = _finding("W2", "a", "high")
    root = Node(node_id="s", kind=NodeKind.SESSION, topic="s", findings=[low, high])

    rank_findings(root)

    assert (high.rank, low.rank) == (0, 1)
