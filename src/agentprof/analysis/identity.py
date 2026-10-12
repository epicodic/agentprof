# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Logical agent owners and stable call keys, shared by every analysis step and the API."""

import math
from collections import Counter
from collections.abc import Iterator
from decimal import Decimal

from agentprof.model import LlmCall, Node, NodeKind, Provenance, iter_nodes

MAIN_OWNER = "main"


def owned_nodes(root: Node, owner: str = MAIN_OWNER) -> Iterator[tuple[str, Node]]:
    """Yield every node depth first with the key of the logical agent that owns it.

    The main agent's key is `MAIN_OWNER`.
    An agent node starts its own logical agent, keyed by its harness agent id (shared by resumes) or else its node id.
    """
    if root.kind is NodeKind.AGENT:
        owner = root.agent_uuid or root.node_id
    yield owner, root
    for child in root.children:
        yield from owned_nodes(child, owner)


def timestamp_key(timestamp: float) -> str:
    """Spell a finite timestamp like the browser's `String(number)`, so keys in existing URLs stay valid."""
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


def _finite_start(call: LlmCall) -> float | None:
    value = call.start.value
    if value is None or not math.isfinite(float(value)):
        return None
    return float(value)


def call_keys(calls: list[LlmCall]) -> list[str | None]:
    """The stable key of each call among one owner's calls, or `None` where no unique identity exists.

    A nonempty native id unique among the calls gives `id:<id>`; a duplicate native id never falls back to time.
    Without a native id, an exact finite start unique among all finite starts gives `time:<start>`.
    """
    id_counts = Counter(call.call_id for call in calls if call.call_id)
    start_counts = Counter(start for call in calls if (start := _finite_start(call)) is not None)
    keys: list[str | None] = []
    for call in calls:
        start = _finite_start(call)
        if call.call_id:
            keys.append(f"id:{call.call_id}" if id_counts[call.call_id] == 1 else None)
        elif start is not None and call.start.provenance is Provenance.EXACT and start_counts[start] == 1:
            keys.append(f"time:{timestamp_key(start)}")
        else:
            keys.append(None)
    return keys


def assign_call_keys(root: Node) -> None:
    """Store every call's stable key on `LlmCall.call_key`, owner by owner."""
    for node in iter_nodes(root):
        for call, key in zip(node.llm_calls, call_keys(node.llm_calls), strict=True):
            call.call_key = key
