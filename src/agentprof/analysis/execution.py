# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Resolve source-record relationships to model calls."""

from collections import defaultdict

from agentprof.model import EventCallLink, LlmCall, Node, NodeKind

_VALID_EVIDENCE = {
    "requested_by": "recorded",
    "consumed_by": "recorded",
    "next_observed_call": "observed_order",
}


def resolve_execution_links(root: Node) -> None:
    """Resolve event links to one request in the same logical agent stream."""
    calls: dict[str, dict[str, list[tuple[str, LlmCall]]]] = defaultdict(lambda: defaultdict(list))
    pending: list[tuple[str, EventCallLink]] = []

    def visit(node: Node, owner: str) -> None:
        if node.kind is NodeKind.AGENT:
            owner = node.agent_uuid or node.node_id
        if node.kind in (NodeKind.SESSION, NodeKind.TURN, NodeKind.AGENT):
            for call in node.llm_calls:
                if call.source_request_id:
                    calls[owner][call.source_request_id].append((node.node_id, call))
        pending.extend((owner, link) for event in node.execution_events for link in event.links)
        for child in node.children:
            visit(child, owner)

    visit(root, "main")
    for owner, link in pending:
        link.owner_id = None
        if _VALID_EVIDENCE.get(link.relation) != link.evidence:
            continue
        matches = calls[owner].get(link.source_request_id, [])
        if len(matches) == 1:
            link.owner_id = matches[0][0]
