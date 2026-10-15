# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Build stable, unambiguous references for evidence-backed findings."""

from agentprof.model import ExecutionEvent, FindingReference, Node


def node_reference(node: Node) -> FindingReference:
    """Reference a node by its stable node id and use its topic or native tool name as the label."""
    label = node.tool.native_id if node.tool is not None else node.topic
    return FindingReference(kind="node", owner_id=node.node_id, key=node.node_id, label=label)


def call_references(owner: Node) -> dict[int, FindingReference]:
    """References to `owner`'s calls, keyed by `id(call)` and labelled by position ("LLM call 3").

    A call without a `LlmCall.call_key` (set by `identity.assign_call_keys`) has no reference.
    """
    return {
        id(call): FindingReference(kind="call", owner_id=owner.node_id, key=call.call_key, label=f"LLM call {index}")
        for index, call in enumerate(owner.llm_calls, start=1)
        if call.call_key is not None
    }


def event_reference(owner: Node, event: ExecutionEvent) -> FindingReference | None:
    """Reference an event only when its nonempty event id is unique within its owner."""
    if not event.event_id:
        return None
    if sum(other.event_id == event.event_id for other in owner.execution_events) != 1:
        return None
    return FindingReference(kind="event", owner_id=owner.node_id, key=event.event_id, label=event.kind)
