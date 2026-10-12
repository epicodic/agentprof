# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""The order of a session's findings: known avoidable USD, severity, then event time."""

from agentprof.model import Finding, Node, iter_nodes

_SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def _event_time(finding: Finding, node: Node) -> float | None:
    observed = finding.evidence.get("call_start_ms")
    if isinstance(observed, (int, float)) and not isinstance(observed, bool):
        return float(observed)
    return node.start.value


def ordered_findings(root: Node) -> list[Finding]:
    """Every finding in the tree, most costly first."""

    def key(item: tuple[Finding, float | None]) -> tuple[bool, float, int, bool, float, str, str]:
        finding, time = item
        usd = finding.estimated_avoidable_cost.usd
        return (
            usd is None,
            -usd if usd is not None else 0.0,
            _SEVERITY_ORDER.get(finding.severity, len(_SEVERITY_ORDER)),
            time is None,
            time if time is not None else 0.0,
            finding.heuristic_id,
            finding.node_id,
        )

    attached = [(finding, _event_time(finding, node)) for node in iter_nodes(root) for finding in node.findings]
    return [finding for finding, _ in sorted(attached, key=key)]


def rank_findings(root: Node) -> None:
    """Store each finding's position in `ordered_findings` as its `rank`."""
    for rank, finding in enumerate(ordered_findings(root)):
        finding.rank = rank
