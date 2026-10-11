# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Build stable, unambiguous references for evidence-backed findings."""

import math
from decimal import Decimal

from agentprof.model import ExecutionEvent, FindingReference, LlmCall, Node, Provenance


def _timestamp_key(timestamp: float) -> str:
    """Spell a finite numeric timestamp using the browser's decimal/exponent thresholds."""
    if timestamp == 0:
        return "0"
    text = repr(timestamp)
    if 1e-6 <= abs(timestamp) < 1e21:
        decimal = format(Decimal(text), "f")
        return decimal.rstrip("0").rstrip(".") if "." in decimal else decimal
    mantissa, exponent = text.split("e")
    exponent_number = int(exponent)
    sign = "+" if exponent_number >= 0 else "-"
    return f"{mantissa.removesuffix('.0')}e{sign}{abs(exponent_number)}"


def node_reference(node: Node) -> FindingReference:
    """Reference a node by its stable node id and use its topic or native tool name as the label."""
    label = node.tool.native_id if node.tool is not None else node.topic
    return FindingReference(kind="node", owner_id=node.node_id, key=node.node_id, label=label)


def call_reference(owner: Node, call: LlmCall, owner_calls: list[LlmCall]) -> FindingReference | None:
    """Reference a call only when its native id or exact finite start uniquely identifies it in its owner."""
    scoped_calls = owner.llm_calls if call in owner.llm_calls else owner_calls
    label = f"LLM call {scoped_calls.index(call) + 1}"
    if call.call_id:
        if sum(other.call_id == call.call_id for other in owner_calls) != 1:
            return None
        return FindingReference(kind="call", owner_id=owner.node_id, key=f"id:{call.call_id}", label=label)
    if call.start.value is None or call.start.provenance is not Provenance.EXACT:
        return None
    timestamp = float(call.start.value)
    if not math.isfinite(timestamp):
        return None
    matches = sum(
        other.start.value is not None
        and math.isfinite(float(other.start.value))
        and float(other.start.value) == timestamp
        for other in owner_calls
    )
    if matches != 1:
        return None
    timestamp_key = _timestamp_key(timestamp)
    return FindingReference(kind="call", owner_id=owner.node_id, key=f"time:{timestamp_key}", label=label)


def event_reference(owner: Node, event: ExecutionEvent) -> FindingReference | None:
    """Reference an event only when its nonempty event id is unique within its owner."""
    if not event.event_id:
        return None
    if sum(other.event_id == event.event_id for other in owner.execution_events) != 1:
        return None
    return FindingReference(kind="event", owner_id=owner.node_id, key=event.event_id, label=event.kind)
