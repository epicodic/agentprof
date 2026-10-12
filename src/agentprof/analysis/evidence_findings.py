# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Findings that cite measured call intervals and cache behavior.

These are diagnostic hints. A large rewrite does not, by itself, establish cache expiry or prove that its cost could
have been avoided.
"""

from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from itertools import pairwise

from agentprof.analysis.finding_references import call_references, event_reference, node_reference
from agentprof.analysis.identity import owned_nodes
from agentprof.model import (
    CallEvent,
    CostMetric,
    Finding,
    FindingReference,
    LlmCall,
    Metric,
    Node,
    NodeKind,
    Provenance,
    context_size,
    iter_nodes,
    sum_costs,
    worst_provenance,
)

_AGENT_KINDS = (NodeKind.TURN, NodeKind.AGENT)

_BLOCKING_WAIT_MS = 5 * 60 * 1000
_PARENT_IDLE_MS = 5 * 60 * 1000
_LONG_GAP_MS = 5 * 60 * 1000
_CONTEXT_GROWTH_TOKENS = 100_000
_CONTEXT_GROWTH_FACTOR = 2


@dataclass
class _Context:
    """What the evidence checks read, built once per tree."""

    nodes: list[Node]
    by_id: dict[str, Node]
    agent_nodes: list[Node]
    """Turn and agent nodes, depth first."""
    calls: dict[str, list[tuple[LlmCall, Node]]]
    """Per logical agent: its in-context calls with a start, by start, each with the node that holds it."""
    compactions: dict[str, list[tuple[Metric, Node]]]
    """Per logical agent: its compaction points, each with the node that recorded it."""
    _references: dict[int, dict[int, FindingReference]] = field(init=False, default_factory=dict)

    def call_ref(self, owner: Node, call: LlmCall) -> list[FindingReference]:
        """A zero or one element list with the reference of `call`, one of `owner`'s calls."""
        references = self._references.get(id(owner))
        if references is None:
            references = self._references[id(owner)] = call_references(owner)
        reference = references.get(id(call))
        return [reference] if reference is not None else []


def _context(root: Node) -> _Context:
    calls: dict[str, list[tuple[LlmCall, Node]]] = defaultdict(list)
    compactions: dict[str, list[tuple[Metric, Node]]] = defaultdict(list)
    for owner, node in owned_nodes(root):
        if node.kind in _AGENT_KINDS:
            calls[owner].extend(
                (call, node) for call in node.llm_calls if call.in_context and call.start.value is not None
            )
            compactions[owner].extend((point, node) for point in node.compactions)
    for owner_calls in calls.values():
        owner_calls.sort(key=lambda item: item[0].start.number())
    nodes = list(iter_nodes(root))
    return _Context(
        nodes=nodes,
        by_id={node.node_id: node for node in nodes},
        agent_nodes=[node for node in nodes if node.kind in _AGENT_KINDS],
        calls=dict(calls),
        compactions=dict(compactions),
    )


def _observed_cache_write_cost(call: LlmCall) -> CostMetric:
    """Sum both measured cache write cost parts, or return unavailable if either part is missing."""
    five_minute = call.cost_parts.get("cache_write_5m", CostMetric.not_available())
    one_hour = call.cost_parts.get("cache_write_1h", CostMetric.not_available())
    if five_minute.value is None or one_hour.value is None:
        return CostMetric.not_available()
    return sum_costs([five_minute, one_hour])


def _is_blocking_wait(context: _Context, event: CallEvent) -> bool:
    """A timed tool call that waited on the user for at least five minutes."""
    tool_node = context.by_id.get(event.event_id)
    return (
        event.kind == "tool"
        and tool_node is not None
        and tool_node.tool is not None
        and tool_node.tool.blocks_on_user
        and event.duration.value is not None
        and event.duration.number() >= _BLOCKING_WAIT_MS
    )


def _cache_rewrite_findings(context: _Context, node: Node, call: LlmCall) -> list[Finding]:
    evidence: dict[str, object] = {
        "call_id": call.call_id,
        "call_start_ms": call.start.value,
        "cache_write_tokens": call.tokens.cache_write.value,
        "cache_read_tokens": call.tokens.cache_read.value,
        "gap_ms": call.gap.value,
        "cold_reason": call.cold_reason,
        "provenance": worst_provenance(call.tokens.cache_write.provenance, call.tokens.cache_read.provenance).value,
    }
    call_refs = context.call_ref(node, call)
    findings = [
        Finding(
            heuristic_id="E1",
            node_id=node.node_id,
            severity="medium",
            message="Large cache rewrite with little cache reuse",
            evidence=evidence,
            references=call_refs,
            observed_cost=_observed_cache_write_cost(call),
        )
    ]
    wait = next((event for event in call.preceding_events if _is_blocking_wait(context, event)), None)
    if wait is not None:
        findings.append(
            Finding(
                heuristic_id="E2",
                node_id=node.node_id,
                severity="medium",
                message="Blocking user wait preceded a large cache rewrite",
                evidence={
                    **evidence,
                    "tool_node_id": wait.event_id,
                    "wait_ms": wait.duration.value,
                    "wait_provenance": wait.duration.provenance.value,
                },
                references=[*call_refs, node_reference(context.by_id[wait.event_id])],
                observed_cost=_observed_cache_write_cost(call),
            )
        )
    return findings


def _check_cache_rewrites(context: _Context) -> list[Finding]:
    """E1: a large cache rewrite with little reuse; E2: the same rewrite after a long blocking user wait."""
    return [
        finding
        for node in context.agent_nodes
        for call in node.llm_calls
        if call.cold_rewrite
        for finding in _cache_rewrite_findings(context, node, call)
    ]


def _check_context_growth(context: _Context) -> list[Finding]:
    """E3: a logical agent's context at least doubled, to 100k tokens or more, between consecutive calls."""
    findings: list[Finding] = []
    for calls in context.calls.values():
        for (earlier, earlier_node), (later, later_node) in pairwise(calls):
            before = context_size(earlier.tokens)
            after = context_size(later.tokens)
            if (
                before.value is None
                or after.value is None
                or after.number() < _CONTEXT_GROWTH_TOKENS
                or after.number() < before.number() * _CONTEXT_GROWTH_FACTOR
            ):
                continue
            findings.append(
                Finding(
                    heuristic_id="E3",
                    node_id=later_node.node_id,
                    severity="low",
                    message="Model context grew sharply between calls",
                    evidence={
                        "earlier_call_id": earlier.call_id,
                        "later_call_id": later.call_id,
                        "earlier_context_tokens": before.value,
                        "later_context_tokens": after.value,
                        "provenance": worst_provenance(before.provenance, after.provenance).value,
                    },
                    references=[*context.call_ref(earlier_node, earlier), *context.call_ref(later_node, later)],
                )
            )
    return findings


def _check_idle_parent(context: _Context) -> list[Finding]:
    """E4: a call that started at least five minutes after a child agent completed."""
    findings: list[Finding] = []
    for node in context.agent_nodes:
        for call in node.llm_calls:
            for event in call.preceding_events:
                if event.kind != "child_completion" or event.end.value is None or call.start.value is None:
                    continue
                idle_ms = call.start.number() - event.end.number()
                if idle_ms < _PARENT_IDLE_MS:
                    continue
                child = context.by_id.get(event.event_id)
                findings.append(
                    Finding(
                        heuristic_id="E4",
                        node_id=node.node_id,
                        severity="low",
                        message="Parent agent was idle after a child completed",
                        evidence={
                            "call_id": call.call_id,
                            "child_node_id": event.event_id,
                            "idle_ms": idle_ms,
                            "provenance": worst_provenance(call.start.provenance, event.end.provenance).value,
                        },
                        references=[
                            *context.call_ref(node, call),
                            *([node_reference(child)] if child is not None else []),
                        ],
                    )
                )
    return findings


def _check_resumes(context: _Context) -> list[Finding]:
    """E5: a recorded agent resume, from a resume tool call or a resume event, using neutral wording."""
    findings: list[Finding] = []
    resumed_agent_times = {
        (node.tool.linked_agent_node_id, node.start.value)
        for node in context.nodes
        if node.kind is NodeKind.TOOL
        and node.tool is not None
        and node.tool.is_resume
        and node.tool.linked_agent_node_id is not None
        and node.start.value is not None
    }
    for node in context.nodes:
        if node.kind is NodeKind.TOOL and node.tool is not None and node.tool.is_resume:
            findings.append(
                Finding(
                    heuristic_id="E5",
                    node_id=node.node_id,
                    severity="low",
                    message="Agent resume recorded",
                    evidence={
                        "tool_node_id": node.node_id,
                        "target_agent_id": node.tool.target_agent_id,
                        "linked_agent_node_id": node.tool.linked_agent_node_id,
                        "provenance": "exact",
                    },
                    references=[node_reference(node)],
                )
            )
        for event in node.execution_events:
            if event.kind != "resume" or (
                event.start.value is not None and (event.subject_node_id, event.start.value) in resumed_agent_times
            ):
                continue
            references = [reference] if (reference := event_reference(node, event)) is not None else []
            findings.append(
                Finding(
                    heuristic_id="E5",
                    node_id=node.node_id,
                    severity="low",
                    message="Agent resume recorded",
                    evidence={"provenance": event.start.provenance.value},
                    references=references,
                )
            )
    return findings


def _check_long_gaps(context: _Context) -> list[Finding]:
    """E6: at least five minutes between consecutive calls of one logical agent, as `annotate_call_context` measured."""
    findings: list[Finding] = []
    for calls in context.calls.values():
        for (earlier, earlier_node), (later, later_node) in pairwise(calls):
            if later.gap.value is None or later.gap.number() < _LONG_GAP_MS:
                continue
            findings.append(
                Finding(
                    heuristic_id="E6",
                    node_id=later_node.node_id,
                    severity="low",
                    message="Long interval between model calls",
                    evidence={
                        "earlier_call_id": earlier.call_id,
                        "later_call_id": later.call_id,
                        "gap_ms": later.gap.value,
                        "basis": later.gap_basis,
                        "provenance": later.gap.provenance.value,
                        "intervening_events": [_event_evidence(event) for event in later.preceding_events],
                    },
                    references=[
                        *context.call_ref(earlier_node, earlier),
                        *context.call_ref(later_node, later),
                        *(
                            node_reference(context.by_id[event.event_id])
                            for event in later.preceding_events
                            if event.event_id in context.by_id
                        ),
                    ],
                )
            )
    return findings


def _event_evidence(event: CallEvent) -> dict[str, object]:
    return {
        "kind": event.kind,
        "event_id": event.event_id,
        "start_ms": event.start.value,
        "end_ms": event.end.value,
        "duration_ms": event.duration.value,
    }


def _compaction_finding(context: _Context, point: Metric, node: Node, calls: list[tuple[LlmCall, Node]]) -> Finding:
    """One E7 finding for a compaction point, citing the calls on either side of it and its event."""
    before = [item for item in calls if point.value is not None and item[0].start.number() < point.number()]
    after = [item for item in calls if point.value is not None and item[0].start.number() >= point.number()]
    adjacent = before[-1:] + after[:1]
    event_refs = [
        reference
        for event in node.execution_events
        if event.kind == "compaction"
        and point.value is not None
        and event.start.value == point.value
        and (reference := event_reference(node, event)) is not None
    ]
    call_refs = [reference for call, call_node in adjacent for reference in context.call_ref(call_node, call)]
    provenance = worst_provenance(point.provenance, *(call.start.provenance for call, _ in adjacent))
    if before and after:
        message = (
            "Context compaction recorded between model calls"
            if provenance is Provenance.EXACT
            else "Context compaction evidence falls between model calls"
        )
    else:
        message = (
            "Context compaction recorded"
            if point.provenance is Provenance.EXACT
            else "Context compaction estimate recorded"
        )
    return Finding(
        heuristic_id="E7",
        node_id=node.node_id,
        severity="low",
        message=message,
        evidence={
            "compaction_ms": point.value,
            "basis": "recorded_compaction" if point.provenance is Provenance.EXACT else "estimated_compaction",
            "provenance": provenance.value,
            "earlier_call_id": before[-1][0].call_id if before else None,
            "later_call_id": after[0][0].call_id if after else None,
        },
        references=list(dict.fromkeys([*call_refs, *event_refs])),
    )


def _check_compactions(context: _Context) -> list[Finding]:
    """E7: a recorded or estimated context compaction of a logical agent."""
    return [
        _compaction_finding(context, point, node, context.calls[owner])
        for owner, points in context.compactions.items()
        for point, node in points
    ]


_CHECKS: tuple[Callable[[_Context], list[Finding]], ...] = (
    _check_cache_rewrites,
    _check_context_growth,
    _check_idle_parent,
    _check_resumes,
    _check_long_gaps,
    _check_compactions,
)


def find_evidence_findings(root: Node) -> list[Finding]:
    """Return evidence-backed findings over the neutral call tree; run after `call_context.annotate_call_context`."""
    context = _context(root)
    return [finding for check in _CHECKS for finding in check(context)]
