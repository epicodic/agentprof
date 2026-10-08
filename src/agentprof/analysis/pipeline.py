# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Full analysis of one session: adapter parse, roll-ups and heuristics."""

from agentprof.adapters.base import AgentAdapter, SessionRef
from agentprof.analysis.call_context import annotate_call_context
from agentprof.analysis.evidence_findings import find_evidence_findings
from agentprof.analysis.execution import resolve_execution_links
from agentprof.analysis.heuristics import find_findings
from agentprof.analysis.rollup import roll_up
from agentprof.model import Finding, Node, Session, iter_nodes


def attach_findings(root: Node, findings: list[Finding]) -> None:
    """Append each finding to the `findings` of the node it names."""
    nodes_by_id = {node.node_id: node for node in iter_nodes(root)}
    for finding in findings:
        node = nodes_by_id.get(finding.node_id)
        if node is None:
            raise ValueError(f"finding {finding.heuristic_id} references unknown node {finding.node_id!r}")
        node.findings.append(finding)


def analyze(adapter: AgentAdapter, ref: SessionRef) -> Session:
    """Parse `ref` with `adapter`, fill derived metrics, and attach waste findings."""
    session = adapter.analyze(ref)
    resolve_execution_links(session.root)
    roll_up(session.root)
    annotate_call_context(session.root)
    attach_findings(session.root, [*find_findings(session.root), *find_evidence_findings(session.root)])
    return session
