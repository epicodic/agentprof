# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Findings that cite measured call intervals and cache behavior.

These are diagnostic hints. A large rewrite does not, by itself, establish cache expiry or prove that its cost could
have been avoided.
"""

from collections import defaultdict
from itertools import pairwise

from agentprof.analysis.finding_references import call_reference, event_reference, node_reference
from agentprof.analysis.identity import owned_nodes
from agentprof.model import (
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

_BLOCKING_WAIT_MS = 5 * 60 * 1000
_PARENT_IDLE_MS = 5 * 60 * 1000
_LONG_GAP_MS = 5 * 60 * 1000
_CONTEXT_GROWTH_TOKENS = 100_000
_CONTEXT_GROWTH_FACTOR = 2


def _call_ref(owner: Node, call: LlmCall) -> list[FindingReference]:
    """Return a zero or one element list for an unambiguous call reference."""
    reference = call_reference(owner, call)
    return [reference] if reference is not None else []


def _observed_cache_write_cost(call: LlmCall) -> CostMetric:
    """Sum both measured cache write cost parts, or return unavailable if either part is missing."""
    five_minute = call.cost_parts.get("cache_write_5m", CostMetric.not_available())
    one_hour = call.cost_parts.get("cache_write_1h", CostMetric.not_available())
    if five_minute.value is None or one_hour.value is None:
        return CostMetric.not_available()
    return sum_costs([five_minute, one_hour])


def _resume_tool_findings(nodes: list[Node]) -> list[Finding]:
    """Return the compatible resume-tool finding, using neutral wording."""
    findings: list[Finding] = []
    resumed_agent_times = {
        (node.tool.linked_agent_node_id, node.start.value)
        for node in nodes
        if node.kind is NodeKind.TOOL
        and node.tool is not None
        and node.tool.is_resume
        and node.tool.linked_agent_node_id is not None
        and node.start.value is not None
    }
    for node in nodes:
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


def find_evidence_findings(root: Node) -> list[Finding]:
    """Return evidence-backed findings over the neutral call tree."""
    nodes = list(iter_nodes(root))
    by_id = {node.node_id: node for node in nodes}
    findings: list[Finding] = []
    owned_calls: dict[str, list[tuple[LlmCall, Node]]] = defaultdict(list)
    owner_compactions: dict[str, list[tuple[Metric, Node]]] = defaultdict(list)

    for owner, node in owned_nodes(root):
        if node.kind in (NodeKind.TURN, NodeKind.AGENT):
            owned_calls[owner].extend((call, node) for call in node.llm_calls if call.in_context)
            owner_compactions[owner].extend((point, node) for point in node.compactions)
    for node in nodes:
        if node.kind not in (NodeKind.TURN, NodeKind.AGENT):
            continue
        for call in node.llm_calls:
            for event in call.preceding_events:
                if (
                    event.kind == "child_completion"
                    and event.end.value is not None
                    and call.start.value is not None
                    and call.start.number() - event.end.number() >= _PARENT_IDLE_MS
                ):
                    child = by_id.get(event.event_id)
                    findings.append(
                        Finding(
                            heuristic_id="E4",
                            node_id=node.node_id,
                            severity="low",
                            message="Parent agent was idle after a child completed",
                            evidence={
                                "call_id": call.call_id,
                                "child_node_id": event.event_id,
                                "idle_ms": call.start.number() - event.end.number(),
                                "provenance": worst_provenance(call.start.provenance, event.end.provenance).value,
                            },
                            references=[
                                *_call_ref(node, call),
                                *([node_reference(child)] if child is not None else []),
                            ],
                        )
                    )
            if not call.cold_rewrite:
                continue
            evidence: dict[str, object] = {
                "call_id": call.call_id,
                "call_start_ms": call.start.value,
                "cache_write_tokens": call.tokens.cache_write.value,
                "cache_read_tokens": call.tokens.cache_read.value,
                "gap_ms": call.gap.value,
                "cold_reason": call.cold_reason,
                "provenance": worst_provenance(
                    call.tokens.cache_write.provenance, call.tokens.cache_read.provenance
                ).value,
            }
            call_refs = _call_ref(node, call)
            findings.append(
                Finding(
                    heuristic_id="E1",
                    node_id=node.node_id,
                    severity="medium",
                    message="Large cache rewrite with little cache reuse",
                    evidence=evidence,
                    references=call_refs,
                    observed_cost=_observed_cache_write_cost(call),
                )
            )
            for event in call.preceding_events:
                tool_node = by_id.get(event.event_id)
                if (
                    event.kind == "tool"
                    and tool_node is not None
                    and tool_node.tool is not None
                    and tool_node.tool.native_id.casefold() == "askuserquestion"
                    and event.duration.value is not None
                    and event.duration.number() >= _BLOCKING_WAIT_MS
                ):
                    findings.append(
                        Finding(
                            heuristic_id="E2",
                            node_id=node.node_id,
                            severity="medium",
                            message="Blocking user wait preceded a large cache rewrite",
                            evidence={
                                **evidence,
                                "tool_node_id": event.event_id,
                                "wait_ms": event.duration.value,
                                "wait_provenance": event.duration.provenance.value,
                            },
                            references=[*call_refs, node_reference(tool_node)],
                            observed_cost=_observed_cache_write_cost(call),
                        )
                    )
                    break
    findings.extend(_resume_tool_findings(nodes))
    for owner_key, calls in owned_calls.items():
        ordered = sorted(
            ((call, node) for call, node in calls if call.start.value is not None),
            key=lambda item: item[0].start.number(),
        )
        for (earlier, earlier_owner), (later, later_owner) in pairwise(ordered):
            before = context_size(earlier.tokens)
            after = context_size(later.tokens)
            refs = [
                *_call_ref(earlier_owner, earlier),
                *_call_ref(later_owner, later),
            ]
            if (
                before.value is not None
                and after.value is not None
                and after.number() >= _CONTEXT_GROWTH_TOKENS
                and after.number() >= before.number() * _CONTEXT_GROWTH_FACTOR
            ):
                findings.append(
                    Finding(
                        heuristic_id="E3",
                        node_id=later_owner.node_id,
                        severity="low",
                        message="Model context grew sharply between calls",
                        evidence={
                            "earlier_call_id": earlier.call_id,
                            "later_call_id": later.call_id,
                            "earlier_context_tokens": before.value,
                            "later_context_tokens": after.value,
                            "provenance": worst_provenance(before.provenance, after.provenance).value,
                        },
                        references=refs,
                    )
                )
            baseline = earlier.start.number()
            basis = "previous_start"
            gap_provenance = worst_provenance(later.start.provenance, earlier.start.provenance)
            if earlier.duration.value is not None:
                baseline += earlier.duration.number()
                basis = "previous_end"
                gap_provenance = worst_provenance(gap_provenance, earlier.duration.provenance)
            else:
                gap_provenance = worst_provenance(gap_provenance, Provenance.ESTIMATED)
            gap_ms = later.start.number() - baseline
            if gap_ms >= _LONG_GAP_MS:
                intervening_events = [
                    {
                        "kind": event.kind,
                        "event_id": event.event_id,
                        "start_ms": event.start.value,
                        "end_ms": event.end.value,
                        "duration_ms": event.duration.value,
                    }
                    for event in later.preceding_events
                    if event.start.value is not None
                    and event.end.value is not None
                    and baseline <= event.start.number()
                    and event.end.number() <= later.start.number()
                ]
                findings.append(
                    Finding(
                        heuristic_id="E6",
                        node_id=later_owner.node_id,
                        severity="low",
                        message="Long interval between model calls",
                        evidence={
                            "earlier_call_id": earlier.call_id,
                            "later_call_id": later.call_id,
                            "gap_ms": gap_ms,
                            "basis": basis,
                            "provenance": gap_provenance.value,
                            "intervening_events": intervening_events,
                        },
                        references=[
                            *refs,
                            *[
                                node_reference(by_id[event.event_id])
                                for event in later.preceding_events
                                if event.event_id in by_id
                                and event.start.value is not None
                                and event.end.value is not None
                                and baseline <= event.start.number()
                                and event.end.number() <= later.start.number()
                            ],
                        ],
                    )
                )
        for compact_point, compact_owner in owner_compactions[owner_key]:
            before_calls = [
                item
                for item in ordered
                if compact_point.value is not None and item[0].start.number() < compact_point.number()
            ]
            after_calls = [
                item
                for item in ordered
                if compact_point.value is not None and item[0].start.number() >= compact_point.number()
            ]
            adjacent = ([before_calls[-1]] if before_calls else []) + ([after_calls[0]] if after_calls else [])
            event_refs = [
                reference
                for event in compact_owner.execution_events
                if event.kind == "compaction"
                and compact_point.value is not None
                and event.start.value == compact_point.value
                and (reference := event_reference(compact_owner, event)) is not None
            ]
            call_refs = [
                reference
                for call, call_owner in adjacent
                if (reference := call_reference(call_owner, call)) is not None
            ]
            unique_refs = list(dict.fromkeys([*call_refs, *event_refs]))
            provenance = compact_point.provenance
            if adjacent:
                provenance = worst_provenance(provenance, *(call.start.provenance for call, _ in adjacent))
            if before_calls and after_calls:
                message = (
                    "Context compaction recorded between model calls"
                    if provenance is Provenance.EXACT
                    else "Context compaction evidence falls between model calls"
                )
            else:
                message = (
                    "Context compaction recorded"
                    if compact_point.provenance is Provenance.EXACT
                    else "Context compaction estimate recorded"
                )
            findings.append(
                Finding(
                    heuristic_id="E7",
                    node_id=compact_owner.node_id,
                    severity="low",
                    message=message,
                    evidence={
                        "compaction_ms": compact_point.value,
                        "basis": "recorded_compaction"
                        if compact_point.provenance is Provenance.EXACT
                        else "estimated_compaction",
                        "provenance": provenance.value,
                        "earlier_call_id": before_calls[-1][0].call_id if before_calls else None,
                        "later_call_id": after_calls[0][0].call_id if after_calls else None,
                    },
                    references=unique_refs,
                )
            )
    return findings
