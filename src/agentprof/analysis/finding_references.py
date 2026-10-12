# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Build stable, unambiguous references for evidence-backed findings."""

from agentprof.model import ExecutionEvent, FindingReference, LlmCall, Node


def node_reference(node: Node) -> FindingReference:
    """Reference a node by its stable node id and use its topic or native tool name as the label."""
    label = node.tool.native_id if node.tool is not None else node.topic
    return FindingReference(kind="node", owner_id=node.node_id, key=node.node_id, label=label)


def call_reference(owner: Node, call: LlmCall) -> FindingReference | None:
    """Reference one of `owner`'s calls by its `LlmCall.call_key` (set by `identity.assign_call_keys`).

    `None` when the call is not one of `owner`'s or has no key.
    """
    index = next((index for index, other in enumerate(owner.llm_calls) if other is call), None)
    if index is None or call.call_key is None:
        return None
    return FindingReference(kind="call", owner_id=owner.node_id, key=call.call_key, label=f"LLM call {index + 1}")


def event_reference(owner: Node, event: ExecutionEvent) -> FindingReference | None:
    """Reference an event only when its nonempty event id is unique within its owner."""
    if not event.event_id:
        return None
    if sum(other.event_id == event.event_id for other in owner.execution_events) != 1:
        return None
    return FindingReference(kind="event", owner_id=owner.node_id, key=event.event_id, label=event.kind)
