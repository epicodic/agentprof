# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Which nodes are still running, and which wait on a running descendant."""

from dataclasses import dataclass

from agentprof.model import Node, NodeKind, Provenance

# Tool nodes are never activity indicators themselves, but a sub-agent nested under one still counts.
_ACTIVE_KINDS = (NodeKind.TURN, NodeKind.AGENT)


@dataclass(frozen=True)
class NodeActivity:
    active: bool
    active_descendant: bool
    activity: str | None


def node_activity(root: Node) -> dict[int, NodeActivity]:
    """Activity of every node in `root`'s tree, keyed by `id(node)`.

    The frontier is the root's rolled-up end: a node whose own end falls short of it has been overtaken by later
    activity elsewhere and is not active, even when that end is not `EXACT`.
    """
    frontier = root.end.value
    result: dict[int, NodeActivity] = {}

    def visit(node: Node) -> bool:
        descendant = any([visit(child) for child in node.children])
        active = (
            node.kind is not NodeKind.SESSION
            and node.start.value is not None
            and node.end.provenance is not Provenance.EXACT
            and (frontier is None or node.end.value is None or node.end.number() >= frontier)
        )
        activity = (
            "waiting"
            if node.kind in _ACTIVE_KINDS and descendant
            else "running"
            if node.kind in _ACTIVE_KINDS and active
            else None
        )
        result[id(node)] = NodeActivity(active=active, active_descendant=descendant, activity=activity)
        return (node.kind in _ACTIVE_KINDS and active) or descendant

    visit(root)
    return result
