# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Findings that cite measured call intervals and cache behavior.

These are diagnostic hints. A large rewrite does not, by itself, establish
cache expiry or prove that its cost could have been avoided.
"""

from collections import defaultdict
from itertools import pairwise

from agentprof.model import Finding, LlmCall, Node, NodeKind, context_size, iter_nodes, worst_provenance

_BLOCKING_WAIT_MS = 5 * 60 * 1000
_PARENT_IDLE_MS = 5 * 60 * 1000
_CONTEXT_GROWTH_TOKENS = 100_000
_CONTEXT_GROWTH_FACTOR = 2


def find_evidence_findings(root: Node) -> list[Finding]:
    """Return evidence-backed findings over the neutral call tree."""
    by_id = {node.node_id: node for node in iter_nodes(root)}
    findings: list[Finding] = []
    owned_calls: dict[str, list[tuple[LlmCall, Node]]] = defaultdict(list)

    def gather(node: Node, owner: str) -> None:
        if node.kind is NodeKind.AGENT:
            owner = node.agent_uuid or node.node_id
        if node.kind in (NodeKind.TURN, NodeKind.AGENT):
            owned_calls[owner].extend((call, node) for call in node.llm_calls if call.in_context)
        for child in node.children:
            gather(child, owner)

    gather(root, "main")
    for node in by_id.values():
        if node.kind is NodeKind.TOOL and node.tool is not None and node.tool.is_resume:
            findings.append(
                Finding(
                    heuristic_id="E5",
                    node_id=node.node_id,
                    severity="low",
                    message="Agent resume reported by a SendMessage result",
                    evidence={
                        "tool_node_id": node.node_id,
                        "target_agent_id": node.tool.target_agent_id,
                        "linked_agent_node_id": node.tool.linked_agent_node_id,
                        "provenance": "exact",
                    },
                )
            )
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
            findings.append(
                Finding(
                    heuristic_id="E1",
                    node_id=node.node_id,
                    severity="medium",
                    message="Large cache rewrite with little cache reuse",
                    evidence=evidence,
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
                        )
                    )
                    break
    for calls in owned_calls.values():
        ordered = sorted(
            ((call, node) for call, node in calls if call.start.value is not None),
            key=lambda item: item[0].start.number(),
        )
        for (earlier, _), (later, node) in pairwise(ordered):
            before = context_size(earlier.tokens)
            after = context_size(later.tokens)
            if (
                before.value is not None
                and after.value is not None
                and after.number() >= _CONTEXT_GROWTH_TOKENS
                and after.number() >= before.number() * _CONTEXT_GROWTH_FACTOR
            ):
                findings.append(
                    Finding(
                        heuristic_id="E3",
                        node_id=node.node_id,
                        severity="low",
                        message="Model context grew sharply between calls",
                        evidence={
                            "earlier_call_id": earlier.call_id,
                            "later_call_id": later.call_id,
                            "earlier_context_tokens": before.value,
                            "later_context_tokens": after.value,
                            "provenance": worst_provenance(before.provenance, after.provenance).value,
                        },
                    )
                )
    return findings
