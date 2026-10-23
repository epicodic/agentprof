# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Build neutral session trees from Codex rollout records."""

import json
from dataclasses import dataclass

from agentprof.adapters.codex.prompts import prompt_topic
from agentprof.adapters.codex.rollout import NativeRecord, Rollout, ToolCall, Turn, UsageRecord
from agentprof.adapters.codex.tools import tool_info
from agentprof.adapters.execution import tool_execution_events
from agentprof.adapters.turns import split_by_turn
from agentprof.model import (
    CostMetric,
    ExecutionEvent,
    LlmCall,
    Metric,
    Node,
    NodeKind,
    Tokens,
    TranscriptBlock,
    TranscriptEntry,
    iter_nodes,
    transcript_entry_id,
)
from agentprof.pricing import PriceTable, Usage

_ENCRYPTED_HANDOVER = "Handover unavailable: Codex stored it encrypted."


def _arguments(raw_input: str | None) -> dict[str, object]:
    """Decode native tool input when it is a JSON object, otherwise retain no structured arguments."""
    if raw_input is None:
        return {}
    try:
        arguments = json.loads(raw_input)
    except json.JSONDecodeError:
        return {"patch": raw_input} if "*** Update File:" in raw_input else {}
    return arguments if isinstance(arguments, dict) else {}


def _native_arguments(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return value
    return _arguments(value if isinstance(value, str) else None)


def _usage(usage: UsageRecord) -> Usage:
    """Convert a native Codex usage record to the shared price-table representation."""
    return Usage(
        input=usage.input,
        output=usage.output,
        cache_read=usage.cache_read,
        cache_write_5m=usage.cache_write,
        cache_write_1h=0,
    )


def usage_cost(prices: PriceTable, model: str | None, usage: UsageRecord) -> CostMetric:
    """Estimate API-equivalent cost only when every disjoint pricing count is available."""
    fields = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens")
    if not all(usage.has_field(name) for name in fields):
        return CostMetric.not_available()
    return prices.cost(model, _usage(usage))


def _llm_calls(turn: Turn, prices: PriceTable, source_stream_id: str | None = None) -> list[LlmCall]:
    """Build one timed LLM call for every native usage record in a turn."""
    calls: list[LlmCall] = []
    for record in turn.token_usages:
        start = record.timestamp_ms if record.timestamp_ms is not None else turn.start_ms
        call = LlmCall(
            start=Metric.exact(start) if start is not None else Metric.not_available(),
            model=turn.model,
            source_request_id=record.response_id,
            source_order=record.source_order,
            source_stream_id=source_stream_id,
            timing_basis="usage_report" if record.timestamp_ms is not None else "turn_start",
        )
        usage = record.usage
        call.tokens = Tokens(
            input=(
                Metric.exact(usage.input)
                if all(
                    usage.has_field(name)
                    for name in ("input_tokens", "cached_input_tokens", "cache_write_input_tokens")
                )
                else Metric.not_available()
            ),
            output=Metric.exact(usage.output) if usage.has_field("output_tokens") else Metric.not_available(),
            cache_read=Metric.exact(usage.cache_read)
            if usage.has_field("cached_input_tokens")
            else Metric.not_available(),
            cache_write=Metric.exact(usage.cache_write)
            if usage.has_field("cache_write_input_tokens")
            else Metric.not_available(),
        )
        call.cost = usage_cost(prices, turn.model, usage)
        call.price_prefix = prices.matching_prefix(turn.model)
        call.cost_parts = prices.cost_parts(turn.model, _usage(usage))
        call.cost_parts["cache_write_5m"] = CostMetric.not_available()
        call.cost_parts["cache_write_1h"] = CostMetric.not_available()
        for kind in ("input", "output", "cache_read"):
            if getattr(call.tokens, kind).value is None:
                call.cost_parts[kind] = CostMetric.not_available()
        calls.append(call)
    return calls


def _tool_node(tool: ToolCall) -> Node:
    """Translate one native tool call and its optional output to a leaf node."""
    arguments = _arguments(tool.input)
    info = tool_info(tool.name, arguments)
    node = Node(
        node_id=tool.call_id or f"tool-{tool.name}-{tool.start_ms}",
        kind=NodeKind.TOOL,
        topic=_tool_topic(tool.name, arguments),
        tool=info,
        start=Metric.exact(tool.start_ms) if tool.start_ms is not None else Metric.not_available(),
    )
    if tool.output is not None:
        node.result = tool.output
        node.success = _success(tool)
        if tool.name.removeprefix("functions.") == "resume_agent" and node.success is True:
            info.is_resume = True
            target = arguments.get("id")
            info.target_agent_id = target if isinstance(target, str) and target else None
    if tool.end_ms is not None:
        node.end = Metric.exact(tool.end_ms)
        if tool.start_ms is not None:
            node.duration = Metric.exact(tool.end_ms - tool.start_ms)
    return node


def _success(tool: ToolCall) -> bool:
    """Whether native call and output statuses do not report a failure."""
    return all(status not in {"failed", "error", "cancelled"} for status in (tool.status, tool.output_status) if status)


def _tool_events(tool: ToolCall, node: Node, stream_id: str | None) -> list[ExecutionEvent]:
    is_delegation = node.tool is not None and node.tool.category.value == "subagent"
    return tool_execution_events(
        invocation_id=tool.call_id,
        subject_node_id=tool.call_id,
        start=Metric.exact(tool.start_ms) if tool.start_ms is not None else Metric.not_available(),
        end=Metric.exact(tool.end_ms) if tool.end_ms is not None else Metric.not_available(),
        result_recorded=tool.result_recorded,
        success=_success(tool) if tool.result_recorded else None,
        delegation=is_delegation,
        start_order=tool.start_order,
        result_order=tool.result_order,
        source_stream_id=stream_id,
    )


def _tool_topic(name: str, arguments: dict[str, object]) -> str:
    """Return an informative label without losing the native name for unfamiliar tools."""
    for key in ("task", "description", "path", "file_path", "cmd", "command", "query", "url"):
        value = arguments.get(key)
        if isinstance(value, str) and value:
            return f"{name}: {value.splitlines()[0][:200]}"
    return name


def _turn(turn: Turn, prices: PriceTable, source_stream_id: str | None) -> Node:
    """Build one neutral turn from its direct tools and LLM usage records."""
    stream_id = turn.source_stream_id or source_stream_id
    calls = _llm_calls(turn, prices, stream_id)
    children = [_tool_node(tool) for tool in turn.tools]
    events = [
        ExecutionEvent(
            kind="user_input",
            event_id=f"user-input:{record.message_id}" if record.message_id else None,
            start=Metric.exact(record.timestamp_ms) if record.timestamp_ms is not None else Metric.not_available(),
            source_order=record.source_order,
            source_stream_id=stream_id,
        )
        for record in turn.user_inputs
    ]
    for tool, child in zip(turn.tools, children, strict=True):
        events.extend(_tool_events(tool, child, stream_id))
    events.extend(
        ExecutionEvent(
            kind="compaction",
            event_id=record.event_id,
            start=Metric.exact(record.timestamp_ms) if record.timestamp_ms is not None else Metric.not_available(),
            source_order=record.source_order,
            source_stream_id=stream_id,
        )
        for record in turn.compactions
    )
    for result in turn.unmatched_tool_results:
        result_events = tool_execution_events(
            invocation_id=result.call_id,
            subject_node_id=None,
            start=Metric.not_available(),
            end=Metric.exact(result.timestamp_ms) if result.timestamp_ms is not None else Metric.not_available(),
            result_recorded=True,
            success=result.status not in {"failed", "error", "cancelled"} if result.status is not None else None,
            result_order=result.source_order,
            source_stream_id=stream_id,
        )
        events.append(result_events[1])
    if turn.completion_recorded:
        events.append(
            ExecutionEvent(
                kind="completion",
                event_id=f"completion:{turn.turn_id}",
                start=Metric.exact(turn.end_ms) if turn.end_ms is not None else Metric.not_available(),
                source_order=turn.completion_order,
                source_stream_id=stream_id,
            )
        )
    events.sort(key=lambda event: (event.source_order is None, event.source_order or 0))
    node = Node(
        node_id=turn.turn_id,
        kind=NodeKind.TURN,
        topic=prompt_topic(turn.prompt),
        prompt=turn.prompt or "",
        model=turn.model,
        children=children,
        start=Metric.exact(turn.start_ms) if turn.start_ms is not None else Metric.not_available(),
        end=Metric.exact(turn.end_ms) if turn.end_ms is not None else Metric.not_available(),
        llm_calls=calls,
        llm_call_count=Metric.exact(len(calls)),
        execution_events=events,
        compactions=[event.start for event in events if event.kind == "compaction"],
    )
    if turn.start_ms is not None and turn.end_ms is not None:
        node.duration = Metric.exact(turn.end_ms - turn.start_ms)
    return node


def _agent_node(rollout: Rollout, prices: PriceTable) -> Node:
    """Build an agent node whose own calls and tools span every rollout turn."""
    stream_id = rollout.thread_id or rollout.session_id
    calls = [call for turn in rollout.turns for call in _llm_calls(turn, prices, stream_id)]
    tools = [_tool_node(tool) for turn in rollout.turns for tool in turn.tools]
    starts = [value for turn in rollout.turns if (value := turn.start_ms) is not None]
    ends = [value for turn in rollout.turns if (value := turn.end_ms) is not None]
    complete = bool(rollout.turns) and all(turn.end_ms is not None for turn in rollout.turns)
    prompt = (
        _ENCRYPTED_HANDOVER
        if _parent_thread_id(rollout) is not None
        else next((turn.prompt for turn in rollout.turns if turn.prompt), "")
    )
    topic = rollout.agent_nickname or (rollout.thread_spawn.agent_path if rollout.thread_spawn else None) or "(orphan)"
    node = Node(
        node_id=f"agent-{rollout.thread_id or rollout.session_id or 'unknown'}",
        kind=NodeKind.AGENT,
        topic=topic,
        agent_uuid=rollout.thread_id or rollout.session_id,
        prompt=prompt,
        result=rollout.result or "",
        model=next((turn.model for turn in rollout.turns if turn.model), rollout.model),
        children=tools,
        start=Metric.exact(min(starts)) if starts else Metric.not_available(),
        end=Metric.exact(max(ends)) if ends and complete else Metric.not_available(),
        llm_calls=calls,
        llm_call_count=Metric.exact(len(calls)),
        compactions=[
            Metric.exact(record.timestamp_ms) if record.timestamp_ms is not None else Metric.not_available()
            for turn in rollout.turns
            for record in turn.compactions
        ],
        execution_events=sorted(
            (event for turn in rollout.turns for event in _turn(turn, prices, stream_id).execution_events),
            key=lambda event: (event.source_order is None, event.source_order or 0),
        ),
    )
    if starts and ends and complete:
        node.duration = Metric.exact(max(ends) - min(starts))
    return node


def _transcript_entry(
    record: NativeRecord, block: TranscriptBlock, block_position: int, owner: Node
) -> TranscriptEntry:
    kind = record.kind
    if block.kind in {"tool_request", "tool_result"}:
        kind = block.kind
        if kind == "tool_request" and isinstance(block.data, dict):
            name = block.data.get("name")
            arguments = _native_arguments(block.data.get("arguments"))
            if isinstance(name, str) and tool_info(name, arguments).category.value == "subagent":
                kind = "delegation"
    if record.kind == "compaction":
        kind = "compaction"
    return TranscriptEntry(
        entry_id=transcript_entry_id(record.source_stream_id, record.source_position, block_position, record.native_id),
        owner_id=owner.node_id,
        source_stream_id=record.source_stream_id,
        source_position=record.source_position,
        logical_stream_id=record.logical_stream_id,
        block_position=block_position,
        native_id=record.native_id,
        native_ordinal=record.native_ordinal,
        timestamp=Metric.exact(record.timestamp_ms) if record.timestamp_ms is not None else Metric.not_available(),
        kind=kind,
        role=record.role,
        sender=record.sender,
        recipient=record.recipient,
        channel=record.channel,
        blocks=[block],
        source_request_id=record.response_id,
        invocation_id=record.invocation_id,
        ownership_evidence=record.ownership_evidence,
    )


def _attach_native_records(
    root: Node,
    main: Rollout,
    subagents: list[Rollout],
    agents: dict[int, Node],
    turn_nodes: dict[tuple[str | None, str], Node],
    delegation_subjects: dict[tuple[int, str], list[str]],
) -> None:
    """Attach retained source items after active-task ownership and agent nesting are known."""
    _set_source_presence(root, main, subagents, agents, turn_nodes)
    event_index: dict[tuple[str | None, str], list[ExecutionEvent]] = {}
    invocation_subjects: dict[tuple[str, str], str] = {}
    invocation_occurrences: dict[tuple[str, str], int] = {}
    for rollout in (main, *subagents):
        for record in rollout.native_records:
            if record.kind == "tool_request" and record.invocation_id is not None:
                key = (record.source_stream_id, record.invocation_id)
                invocation_occurrences[key] = invocation_occurrences.get(key, 0) + 1
    nodes = list(iter_nodes(root))
    node_by_id: dict[str, list[Node]] = {}
    for node in nodes:
        node_by_id.setdefault(node.node_id, []).append(node)
    for node in nodes:
        for event in node.execution_events:
            if event.event_id is not None:
                event_index.setdefault((event.source_stream_id, event.event_id), []).append(event)

    lookups = _EventLookups(event_index, node_by_id, invocation_occurrences, invocation_subjects, delegation_subjects)
    for rollout, agent in [(main, None), *((rollout, agents.get(id(rollout))) for rollout in subagents)]:
        for record in rollout.native_records:
            owner = agent or turn_nodes.get((record.source_stream_id, record.owner_turn_id), root)
            blocks = record.blocks or [TranscriptBlock(kind="message")]
            for block_position, block in enumerate(blocks):
                entry = _transcript_entry(record, block, block_position, owner)
                _link_execution_event(entry, record, owner, lookups)
                owner.transcript_entries.append(entry)
                _add_entry_coverage(owner, entry, block)
        if rollout.malformed_lines:
            owner = agent or root
            owner.transcript_coverage.source_present = True
            if "malformed_lines_skipped" not in owner.transcript_coverage.reasons:
                owner.transcript_coverage.reasons.append("malformed_lines_skipped")
    for node in iter_nodes(root):
        node.transcript_entries.sort(
            key=lambda entry: (entry.source_stream_id, entry.source_position, entry.block_position)
        )
    _attach_terminal_results(main, subagents, agents, turn_nodes, root)


@dataclass(frozen=True)
class _EventLookups:
    """Indexes used to link a transcript entry to its execution event and subject node.

    `invocation_subjects` is updated in place as entries are linked.
    """

    event_index: dict[tuple[str | None, str], list[ExecutionEvent]]
    node_by_id: dict[str, list[Node]]
    invocation_occurrences: dict[tuple[str, str], int]
    invocation_subjects: dict[tuple[str, str], str]
    delegation_subjects: dict[tuple[int, str], list[str]]


def _set_source_presence(
    root: Node,
    main: Rollout,
    subagents: list[Rollout],
    agents: dict[int, Node],
    turn_nodes: dict[tuple[str | None, str], Node],
) -> None:
    root.transcript_coverage.source_present = main.source_present
    for rollout in subagents:
        agent = agents.get(id(rollout))
        if agent is not None:
            agent.transcript_coverage.source_present = rollout.source_present
    for turn in main.turns:
        owner = turn_nodes.get((turn.native_source_stream_id, turn.turn_id))
        if owner is not None:
            owner.transcript_coverage.source_present = turn.source_present


def _link_execution_event(entry: TranscriptEntry, record: NativeRecord, owner: Node, lookups: _EventLookups) -> None:
    event_id: str | None = None
    if entry.kind == "user_message" and record.native_id is not None:
        event_id = f"user-input:{record.native_id}"
    elif entry.kind == "compaction" and record.event_id is not None:
        event_id = record.event_id
    elif entry.invocation_id is not None and entry.kind in {"tool_request", "tool_result", "delegation"}:
        prefix = "tool-result" if entry.kind == "tool_result" else "tool-start"
        event_id = f"{prefix}:{entry.invocation_id}"
    candidates = lookups.event_index.get((record.logical_stream_id, event_id), []) if event_id else []
    exact = [candidate for candidate in candidates if candidate.source_order == record.source_order]
    if len(exact) == 1:
        entry.event_id = exact[0].event_id
        subject_id = exact[0].subject_node_id
        subject_candidates = lookups.node_by_id.get(subject_id or "", [])
        subject = subject_candidates[0] if len(subject_candidates) == 1 else None
        invocation_key = (record.source_stream_id, entry.invocation_id or "")
        invocation_unique = lookups.invocation_occurrences.get(invocation_key) == 1
        if subject is not None and (entry.invocation_id is None or invocation_unique):
            entry.subject_node_id = subject.node_id
        if entry.kind == "delegation" and entry.invocation_id is not None and invocation_unique:
            matches = lookups.delegation_subjects.get((id(owner), entry.invocation_id), [])
            if len(matches) == 1 and len(lookups.node_by_id.get(matches[0], [])) == 1:
                entry.subject_node_id = matches[0]
        elif entry.kind == "tool_result" and entry.invocation_id is not None and invocation_unique:
            entry.subject_node_id = lookups.invocation_subjects.get((record.source_stream_id, entry.invocation_id))
        if entry.invocation_id is not None and entry.subject_node_id is not None:
            lookups.invocation_subjects[(record.source_stream_id, entry.invocation_id)] = entry.subject_node_id


def _add_entry_coverage(owner: Node, entry: TranscriptEntry, block: TranscriptBlock) -> None:
    coverage = owner.transcript_coverage
    coverage.source_present = True
    if entry.kind not in coverage.categories:
        coverage.categories.append(entry.kind)
    if entry.timestamp.value is None and "missing_timestamps" not in coverage.reasons:
        coverage.reasons.append("missing_timestamps")
    reason = {
        "encrypted": "encrypted_content",
        "unsupported": "unsupported_content",
        "unavailable": "unavailable_content",
    }.get(block.availability)
    if reason is not None and reason not in coverage.reasons:
        coverage.reasons.append(reason)


def _attach_terminal_results(
    main: Rollout,
    subagents: list[Rollout],
    agents: dict[int, Node],
    turn_nodes: dict[tuple[str | None, str], Node],
    root: Node,
) -> None:
    for rollout, agent in [(main, None), *((rollout, agents.get(id(rollout))) for rollout in subagents)]:
        terminal_by_owner: dict[int, tuple[int, Node, str]] = {}
        for record in rollout.native_records:
            is_terminal = (
                record.channel == "final" and record.kind == "assistant_message"
            ) or record.entry_type == "agent_message"
            if not is_terminal:
                continue
            owner = agent or turn_nodes.get((record.source_stream_id, record.owner_turn_id), root)
            if owner.kind is NodeKind.SESSION:
                continue
            terminal_text = "\n".join(block.text for block in record.blocks if block.text is not None)
            if any(block.text is not None and block.availability == "recorded" for block in record.blocks):
                terminal_by_owner[id(owner)] = (record.source_position, owner, terminal_text)
        for _, owner, terminal_text in terminal_by_owner.values():
            if not owner.result:
                owner.result = terminal_text


def _link_names(rollout: Rollout) -> set[str]:
    """Return metadata labels that can identify a spawning delegation tool."""
    values = [rollout.agent_nickname]
    if rollout.thread_spawn is not None:
        values.extend((rollout.thread_spawn.agent_nickname, rollout.thread_spawn.agent_path))
    return {value.lower() for value in values if value}


def _delegation_matches(node: Node, names: set[str]) -> bool:
    if node.tool is None or node.tool.category.value != "subagent":
        return False
    values = (value for value in node.tool.arguments.values() if isinstance(value, str))
    return any(value.lower() in names for value in values)


def _attach_agent(
    parent: Node,
    agent: Node,
    names: set[str],
    delegation_subjects: dict[tuple[int, str], list[str]],
) -> bool:
    """Replace a matching delegation leaf with its corresponding subagent node."""
    for index, child in enumerate(parent.children):
        if child.kind is NodeKind.TOOL and _delegation_matches(child, names):
            delegation_subjects.setdefault((id(parent), child.node_id), []).append(agent.node_id)
            agent.tool = child.tool
            if not agent.result:
                agent.result = child.result
            agent.success = child.success
            task = child.tool.arguments.get("task") if child.tool is not None else None
            if isinstance(task, str) and task:
                agent.prompt = task
            message = child.tool.arguments.get("message") if child.tool is not None else None
            if isinstance(message, str) and message.startswith("gAAAA"):
                agent.prompt = _ENCRYPTED_HANDOVER
            if child.start.value is not None:
                agent.start = child.start
            if agent.end.value is not None and agent.start.value is not None:
                agent.duration = Metric.exact(agent.end.number() - agent.start.number())
            parent.children[index] = agent
            _append_child_completion(parent, agent)
            return True
        if _attach_agent(child, agent, names, delegation_subjects):
            return True
    return False


def _append_child_completion(parent: Node, child: Node) -> None:
    """Copy a source-recorded child terminal event onto its direct calling parent."""
    terminal = next((event for event in reversed(child.execution_events) if event.kind == "completion"), None)
    if terminal is None:
        return
    event_id = None
    if terminal.event_id is not None and child.agent_uuid is not None:
        event_id = f"child-completion:{child.agent_uuid}:{terminal.event_id}"
    parent_stream_id = next(
        (event.source_stream_id for event in parent.execution_events if event.source_stream_id is not None), None
    )
    parent.execution_events.append(
        ExecutionEvent(
            kind="child_completion",
            event_id=event_id,
            subject_node_id=child.node_id,
            start=terminal.start,
            source_stream_id=parent_stream_id or parent.agent_uuid,
        )
    )


def _parent_thread_id(rollout: Rollout) -> str | None:
    """Return the parent thread identifier recorded for a subagent rollout."""
    if rollout.thread_spawn is not None and rollout.thread_spawn.parent_thread_id is not None:
        return rollout.thread_spawn.parent_thread_id
    return rollout.parent_thread_id


def _node_start(node: Node) -> float | None:
    """Return a node's start value for shared turn-splitting logic."""
    return node.start.value


def build_root(main: Rollout, subagents: list[Rollout], prices: PriceTable, title: str) -> Node:
    """Build a session tree, retaining unlinked subagents under the matching main turn."""
    main_stream_id = main.thread_id or main.session_id
    turns = [_turn(turn, prices, main_stream_id) for turn in main.turns]
    root = Node(node_id="session", kind=NodeKind.SESSION, topic=title, children=turns)
    parent_nodes: dict[str, Node] = {main.thread_id or main.session_id or "": root}
    agents = [(rollout, _agent_node(rollout, prices)) for rollout in subagents]
    agent_by_rollout = {id(rollout): agent for rollout, agent in agents}
    delegation_subjects: dict[tuple[int, str], list[str]] = {}
    parent_nodes.update({rollout.thread_id: agent for rollout, agent in agents if rollout.thread_id is not None})
    unlinked: list[Node] = []

    for rollout, agent in agents:
        parent_id = _parent_thread_id(rollout)
        parent = parent_nodes.get(parent_id or "", root)
        if not _attach_agent(parent, agent, _link_names(rollout), delegation_subjects):
            unlinked.append(agent)
    timed_turns = [turn for turn in turns if turn.start.value is not None]
    groups = split_by_turn(unlinked, _node_start, [turn.start.number() for turn in timed_turns])
    if groups:
        for turn, agents_for_turn in zip(timed_turns, groups, strict=True):
            turn.children.extend(agents_for_turn)
    else:
        root.children.extend(unlinked)
    nodes = list(iter_nodes(root))
    for node in nodes:
        if node.tool is None or not node.tool.is_resume or node.tool.target_agent_id is None:
            continue
        matches = [
            candidate
            for candidate in nodes
            if candidate.kind is NodeKind.AGENT and candidate.agent_uuid == node.tool.target_agent_id
        ]
        if len(matches) == 1:
            target = matches[0]
            node.tool.linked_agent_node_id = target.node_id
            if node.end.value is not None:
                target.resume_times.append(node.end)
    turn_nodes = {
        (turn.native_source_stream_id, turn.turn_id): node for turn, node in zip(main.turns, turns, strict=False)
    }
    _attach_native_records(root, main, subagents, agent_by_rollout, turn_nodes, delegation_subjects)
    return root
