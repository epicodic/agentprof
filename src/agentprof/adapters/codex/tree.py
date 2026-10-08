# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Build neutral session trees from Codex rollout records."""

import json

from agentprof.adapters.codex.prompts import prompt_topic
from agentprof.adapters.codex.rollout import Rollout, ToolCall, Turn, UsageRecord
from agentprof.adapters.codex.tools import tool_info
from agentprof.adapters.execution import tool_execution_events
from agentprof.adapters.turns import split_by_turn
from agentprof.model import CostMetric, ExecutionEvent, LlmCall, Metric, Node, NodeKind, Tokens
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


def _usage(usage: UsageRecord) -> Usage:
    """Convert a native Codex usage record to the shared price-table representation."""
    return Usage(
        input=usage.input,
        output=usage.output,
        cache_read=usage.cache_read,
        cache_write_5m=usage.cache_write,
        cache_write_1h=0,
    )


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
            input=Metric.exact(usage.input),
            output=Metric.exact(usage.output),
            cache_read=Metric.exact(usage.cache_read),
            cache_write=Metric.exact(usage.cache_write),
        )
        call.cost = prices.cost(turn.model, _usage(usage))
        call.price_prefix = prices.matching_prefix(turn.model)
        call.cost_parts = prices.cost_parts(turn.model, _usage(usage))
        call.cost_parts["cache_write_5m"] = CostMetric.not_available()
        call.cost_parts["cache_write_1h"] = CostMetric.not_available()
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
    calls = _llm_calls(turn, prices, source_stream_id)
    children = [_tool_node(tool) for tool in turn.tools]
    events = [
        ExecutionEvent(
            kind="user_input",
            event_id=f"user-input:{record.message_id}" if record.message_id else None,
            start=Metric.exact(record.timestamp_ms) if record.timestamp_ms is not None else Metric.not_available(),
            source_order=record.source_order,
            source_stream_id=source_stream_id,
        )
        for record in turn.user_inputs
    ]
    for tool, child in zip(turn.tools, children, strict=True):
        events.extend(_tool_events(tool, child, source_stream_id))
    for result in turn.unmatched_tool_results:
        result_events = tool_execution_events(
            invocation_id=result.call_id,
            subject_node_id=None,
            start=Metric.not_available(),
            end=Metric.exact(result.timestamp_ms) if result.timestamp_ms is not None else Metric.not_available(),
            result_recorded=True,
            success=result.status not in {"failed", "error", "cancelled"} if result.status is not None else None,
            result_order=result.source_order,
            source_stream_id=source_stream_id,
        )
        events.append(result_events[1])
    if turn.completion_recorded:
        events.append(
            ExecutionEvent(
                kind="completion",
                event_id=f"completion:{turn.turn_id}",
                start=Metric.exact(turn.end_ms) if turn.end_ms is not None else Metric.not_available(),
                source_order=turn.completion_order,
                source_stream_id=source_stream_id,
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
        execution_events=sorted(
            (event for turn in rollout.turns for event in _turn(turn, prices, stream_id).execution_events),
            key=lambda event: (event.source_order is None, event.source_order or 0),
        ),
    )
    if starts and ends and complete:
        node.duration = Metric.exact(max(ends) - min(starts))
    return node


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


def _attach_agent(parent: Node, agent: Node, names: set[str]) -> bool:
    """Replace a matching delegation leaf with its corresponding subagent node."""
    for index, child in enumerate(parent.children):
        if child.kind is NodeKind.TOOL and _delegation_matches(child, names):
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
        if _attach_agent(child, agent, names):
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
    parent_nodes.update({rollout.thread_id: agent for rollout, agent in agents if rollout.thread_id is not None})
    unlinked: list[Node] = []

    for rollout, agent in agents:
        parent_id = _parent_thread_id(rollout)
        parent = parent_nodes.get(parent_id or "", root)
        if not _attach_agent(parent, agent, _link_names(rollout)):
            unlinked.append(agent)
    timed_turns = [turn for turn in turns if turn.start.value is not None]
    groups = split_by_turn(unlinked, _node_start, [turn.start.number() for turn in timed_turns])
    if groups:
        for turn, agents_for_turn in zip(timed_turns, groups, strict=True):
            turn.children.extend(agents_for_turn)
    else:
        root.children.extend(unlinked)
    return root
