# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Decide which agent owns each Copilot transcript record.

`decide_owner` is pure: it reads the record and the state in `OwnershipContext`.
`OwnershipContext.observe` then updates that state from the record, in transcript order.
"""

from collections import Counter
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class OwnerDecision:
    """The owning agent of one record and why.

    `owner_key` is the agent's native id, or `None` for the root session.
    `evidence` names the rule that decided; `ambiguous` marks a record whose owner could not be decided.
    `ambiguous_invocation` marks a tool record whose invocation id is not unique.
    `has_explicit_owner` and `parent_known` say whether the record names its owner or a known parent record.
    """

    owner_key: str | None
    evidence: str
    ambiguous: bool
    ambiguous_invocation: bool
    has_explicit_owner: bool
    parent_known: bool


@dataclass
class OwnershipContext:
    """What the owner decision reads: the session's agents and invocations, and the state of earlier records."""

    root_sid: str | None
    agents: frozenset[str]
    invocation_owners: dict[str, str | None]
    ambiguous_tool_ids: frozenset[str]
    event_id_counts: Counter[str]
    owner_by_event: dict[str, str | None] = field(default_factory=dict)
    start_owner: dict[str, str | None] = field(default_factory=dict)
    ambiguous_start_ids: set[str] = field(default_factory=set)
    active: list[str | None] = field(default_factory=lambda: [None])
    parallel_active: set[str] = field(default_factory=set)

    def observe(self, event: dict[str, Any], decision: OwnerDecision, delegation_child_id: str | None) -> None:
        """Update the state after `event` was attached, in the order the single loop used to."""
        data = _data(event)
        event_type = event.get("type")
        tool_call_id = data.get("toolCallId")
        if event_type == "tool.execution_complete" and isinstance(tool_call_id, str):
            self.parallel_active.discard(tool_call_id)
            if tool_call_id in self.active[1:]:
                self.active.remove(tool_call_id)
            self.parallel_active.intersection_update(self.active[1:])
            if len(self.parallel_active) < 2:
                self.parallel_active.clear()
        event_id = event.get("id")
        if isinstance(event_id, str) and self.event_id_counts[event_id] == 1 and not decision.ambiguous:
            self.owner_by_event[event_id] = (
                delegation_child_id
                if delegation_child_id is not None and delegation_child_id in self.agents
                else decision.owner_key
            )
        if event_type == "tool.execution_start" and isinstance(tool_call_id, str):
            if decision.ambiguous or decision.ambiguous_invocation:
                self.ambiguous_start_ids.add(tool_call_id)
            else:
                self.start_owner[tool_call_id] = decision.owner_key
        if (
            delegation_child_id is not None
            and delegation_child_id in self.agents
            and not decision.ambiguous
            and not decision.ambiguous_invocation
        ):
            if self.active[-1] != decision.owner_key and self.active[-1] is not None:
                self.parallel_active.update((self.active[-1], delegation_child_id))
            self.active.append(delegation_child_id)


def source_owner_id(event: dict[str, object], root_sid: str | None) -> tuple[str | None, bool]:
    """Return the owner named by the record's own fields and whether it names one at all."""
    data = event.get("data")
    if not isinstance(data, dict):
        return None, False
    for key in ("ownerId", "agentId", "agentSessionId", "owner", "agent"):
        value = data.get(key)
        if isinstance(value, str):
            return (None if value == root_sid else value), True
        if isinstance(value, dict):
            native_id = value.get("id") or value.get("sessionId")
            if isinstance(native_id, str):
                return (None if native_id == root_sid else native_id), True
    return None, False


def _data(event: dict[str, Any]) -> dict[str, Any]:
    value = event.get("data")
    return value if isinstance(value, dict) else {}


def decide_owner(event: dict[str, Any], context: OwnershipContext) -> OwnerDecision:
    """Decide the owning agent of one transcript record from its fields and the earlier records."""
    data = _data(event)
    event_type = event.get("type")
    explicit_owner, has_explicit_owner = source_owner_id(event, context.root_sid)
    tool_call_id = data.get("toolCallId")
    ambiguous_invocation = (
        event_type in ("tool.execution_start", "tool.execution_complete")
        and isinstance(tool_call_id, str)
        and tool_call_id in context.ambiguous_tool_ids
    )
    if ambiguous_invocation:
        explicit_owner, has_explicit_owner = None, True
    parent_id = event.get("parentId")
    inferred = context.active[-1]
    evidence = "bracket" if inferred is not None else "root"
    ambiguous = False
    parent_known = (
        isinstance(parent_id, str) and context.event_id_counts[parent_id] == 1 and parent_id in context.owner_by_event
    )
    if isinstance(parent_id, str):
        if parent_known:
            inferred = context.owner_by_event[parent_id]
            evidence = "recorded_parent"
        elif not has_explicit_owner:
            inferred, evidence, ambiguous = None, "ambiguous", True
    owner_key = explicit_owner if has_explicit_owner else inferred
    if (
        event_type == "tool.execution_start"
        and isinstance(tool_call_id, str)
        and tool_call_id in context.invocation_owners
        and not ambiguous_invocation
    ):
        invocation_owner = context.invocation_owners[tool_call_id]
        if (has_explicit_owner and explicit_owner != invocation_owner) or (
            parent_known and inferred != invocation_owner
        ):
            owner_key, evidence, ambiguous = None, "ambiguous_conflicting_owner", True
        elif not has_explicit_owner and not parent_known:
            owner_key, evidence = invocation_owner, "explicit_invocation_parent"
    if has_explicit_owner and not ambiguous:
        evidence = "explicit_owner"
    if ambiguous_invocation:
        owner_key, evidence, ambiguous = None, "ambiguous_invocation", True
    if event_type == "tool.execution_complete" and isinstance(tool_call_id, str):
        if tool_call_id in context.ambiguous_start_ids:
            owner_key, evidence, ambiguous = None, "ambiguous_invocation", True
        elif tool_call_id in context.start_owner and not ambiguous_invocation:
            invocation_owner = context.start_owner[tool_call_id]
            if (has_explicit_owner or parent_known) and owner_key != invocation_owner:
                owner_key, evidence, ambiguous = None, "ambiguous_conflicting_owner", True
            elif not has_explicit_owner and not parent_known:
                owner_key, evidence = invocation_owner, "invocation_owner"
    if context.active[-1] in context.parallel_active and not has_explicit_owner and not parent_known:
        owner_key, evidence, ambiguous = None, "ambiguous_parallel", True
    if owner_key is not None and owner_key not in context.agents:
        owner_key, evidence, ambiguous = None, "ambiguous", True
    if event_type == "user.message" and owner_key is None:
        evidence = "root"
    return OwnerDecision(owner_key, evidence, ambiguous, ambiguous_invocation, has_explicit_owner, parent_known)
