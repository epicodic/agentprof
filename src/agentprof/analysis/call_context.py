# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Same-agent call intervals and short references to intervening activity."""

from bisect import bisect_left, bisect_right
from collections import defaultdict
from itertools import pairwise

from agentprof.model import CallEvent, LlmCall, Metric, Node, NodeKind, Provenance, worst_provenance

_LARGE_CACHE_WRITE_TOKENS = 50_000
_LOW_CACHE_READ_RATIO = 0.1


def is_cold_rewrite(call: LlmCall) -> bool:
    """A measured large rewrite with little reuse, excluding an agent's first call."""
    write = call.tokens.cache_write.value
    read = call.tokens.cache_read.value
    return (
        call.gap.value is not None
        and write is not None
        and read is not None
        and write >= _LARGE_CACHE_WRITE_TOKENS
        and read <= write * _LOW_CACHE_READ_RATIO
    )


def _event(node: Node) -> CallEvent | None:
    if node.kind is NodeKind.AGENT:
        if node.end.value is None:
            return None
        return CallEvent("child_completion", node.node_id, node.end, node.end, node.duration)
    if node.kind is NodeKind.TOOL:
        if node.start.value is None or node.end.value is None:
            return None
        return CallEvent("tool", node.node_id, node.start, node.end, node.duration)
    return None


def annotate_call_context(root: Node) -> None:
    """Annotate calls using only timestamps that can place events in their interval.

    The main agent owns all turns. Repeated subagent nodes with the same harness ID
    are treated as one conversation, including a resumed agent.
    """
    calls: dict[str, list[LlmCall]] = defaultdict(list)
    events: dict[str, list[CallEvent]] = defaultdict(list)
    compactions: dict[str, list[Metric]] = defaultdict(list)

    def visit(node: Node, owner: str) -> None:
        if node.kind is NodeKind.AGENT:
            owner = node.agent_uuid or node.node_id
        if node.kind in (NodeKind.TURN, NodeKind.AGENT):
            calls[owner].extend(call for call in node.llm_calls if call.in_context and call.start.value is not None)
            compactions[owner].extend(node.compactions)
            if node.kind is NodeKind.TURN and node.start.value is not None:
                events[owner].append(CallEvent("user_message", node.node_id, node.start, node.start))
        for child in node.children:
            event = _event(child)
            if event is not None:
                events[owner].append(event)
            visit(child, owner)

    visit(root, "main")
    for owner, owned_calls in calls.items():
        owned_calls.sort(key=lambda call: call.start.number())
        timed_events = sorted(
            (event for event in events[owner] if event.start.value is not None and event.end.value is not None),
            key=lambda event: event.start.number(),
        )
        event_starts = [event.start.number() for event in timed_events]
        compact_times = sorted(point.number() for point in compactions[owner] if point.value is not None)
        if owned_calls:
            owned_calls[0].cold_reason = "first_call"
        for previous, current in pairwise(owned_calls):
            baseline = previous.start
            basis = "previous_start"
            if previous.duration.value is not None:
                baseline = Metric(
                    previous.start.number() + previous.duration.number(),
                    previous.start.provenance
                    if previous.duration.provenance is Provenance.EXACT
                    else Provenance.ESTIMATED,
                )
                basis = "previous_end"
            if current.start.number() < baseline.number():
                continue
            provenance = worst_provenance(current.start.provenance, baseline.provenance)
            if basis == "previous_start":
                provenance = worst_provenance(provenance, Provenance.ESTIMATED)
            current.gap = Metric(current.start.number() - baseline.number(), provenance)
            current.gap_basis = basis
            first = bisect_left(event_starts, baseline.number())
            last = bisect_right(event_starts, current.start.number())
            current.preceding_events = [
                event for event in timed_events[first:last] if event.end.number() <= current.start.number()
            ]
            compact_index = bisect_left(compact_times, baseline.number())
            if compact_index < len(compact_times) and compact_times[compact_index] <= current.start.number():
                current.cold_reason = "compaction"
            current.cold_rewrite = is_cold_rewrite(current)
