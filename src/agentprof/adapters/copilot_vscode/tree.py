# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Join a parsed Copilot session with its transcript and debug log into a neutral node tree."""

from collections import Counter

from agentprof.adapters.copilot_vscode.debuglog import DebugLlmCall, DebugLog
from agentprof.adapters.copilot_vscode.session import RawRequest, RawSession, RawToolCall
from agentprof.adapters.copilot_vscode.tools import tool_info
from agentprof.adapters.copilot_vscode.transcript import Transcript
from agentprof.adapters.execution import tool_execution_events
from agentprof.adapters.turns import split_by_turn
from agentprof.model import (
    CostMetric,
    EventCallLink,
    ExecutionEvent,
    LlmCall,
    Metric,
    Node,
    NodeKind,
    Provenance,
    Tokens,
    iter_nodes,
)

_CREDITS = "credits"
_NANO_AIU_PER_CREDIT = 1_000_000_000


def credits_cost(value: float | None, usd_per_credit: float) -> CostMetric:
    """A cost in Copilot credits, convertible to USD at `usd_per_credit`; `n/a` if `value` is `None`."""
    if value is None:
        return CostMetric.not_available()
    return CostMetric(value=value, unit=_CREDITS, provenance=Provenance.EXACT, usd_per_unit=usd_per_credit)


def _exact_or_not_available(value: int | None) -> Metric:
    return Metric.not_available() if value is None else Metric.exact(value)


def _tokens(call: DebugLlmCall) -> Tokens:
    if call.input_tokens is None:
        return Tokens(output=_exact_or_not_available(call.output_tokens))
    cached = call.cached_tokens or 0
    return Tokens(
        input=Metric.exact(call.input_tokens - cached),
        output=_exact_or_not_available(call.output_tokens),
        cache_read=Metric.exact(cached),
    )


def _llm_call_from_debug_log(
    call: DebugLlmCall, in_context: bool, source_stream_id: str | None, usd_per_credit: float
) -> LlmCall:
    return LlmCall(
        start=Metric.exact(call.start_ms),
        duration=Metric.exact(call.duration_ms),
        tokens=_tokens(call),
        model=call.model,
        cost=credits_cost(
            call.usage_nano_aiu / _NANO_AIU_PER_CREDIT if call.usage_nano_aiu is not None else None, usd_per_credit
        ),
        in_context=in_context,
        source_request_id=call.source_request_id,
        source_stream_id=source_stream_id,
        timing_basis="request_start",
    )


def _calls_from_debug_log(
    calls: list[DebugLlmCall], source_stream_id: str | None, usd_per_credit: float
) -> list[LlmCall]:
    """The agent's conversation is its most frequent request kind; other kinds are side requests."""
    conversation = Counter(call.debug_name for call in calls).most_common(1)[0][0] if calls else None
    return [
        _llm_call_from_debug_log(
            call,
            in_context=call.debug_name == conversation,
            source_stream_id=source_stream_id,
            usd_per_credit=usd_per_credit,
        )
        for call in calls
    ]


def _llm_calls(
    key: str | None,
    transcript: Transcript | None,
    debug_log: DebugLog | None,
    source_stream_id: str | None,
    usd_per_credit: float,
) -> list[LlmCall] | None:
    """LLM calls owned by `key` (`None` = main agent), or `None` if no source covers it."""
    if debug_log is not None and key in debug_log.calls:
        return _calls_from_debug_log(debug_log.calls[key], source_stream_id, usd_per_credit)
    if transcript is not None:
        orders = transcript.llm_call_source_orders.get(key, [])
        request_ids = transcript.llm_call_source_request_ids.get(key, [])
        return [
            LlmCall(
                start=Metric.exact(ts),
                source_order=orders[index] if index < len(orders) else None,
                source_stream_id=source_stream_id,
                source_request_id=request_ids[index] if index < len(request_ids) else None,
                timing_basis="assistant_message",
            )
            for index, ts in enumerate(transcript.llm_call_timestamps_ms.get(key, []))
        ]
    return None


def _set_llm_calls(node: Node, calls: list[LlmCall] | None) -> None:
    if calls is None:
        return
    node.llm_calls = calls
    node.llm_call_count = Metric.exact(len(calls))


def _build_tool_node(
    tool_call: RawToolCall, transcript: Transcript | None, usd_per_credit: float, source_stream_id: str | None
) -> Node:
    arguments = tool_call.arguments
    if not arguments and transcript is not None:
        arguments = transcript.tool_arguments.get(tool_call.tool_call_id, {})
    node = Node(
        node_id=tool_call.tool_call_id,
        kind=NodeKind.AGENT if tool_call.is_agent else NodeKind.TOOL,
        topic=tool_call.subagent_description or tool_call.topic,
        agent_uuid=tool_call.tool_call_id if tool_call.is_agent else None,
        model=tool_call.subagent_model,
        prompt=tool_call.subagent_prompt or "",
        result=tool_call.subagent_result or "",
        tool=tool_info(tool_call.tool_id, arguments),
        cost_total=credits_cost(tool_call.subagent_credits, usd_per_credit),
    )
    timing = transcript.tool_timings.get(tool_call.tool_call_id) if transcript is not None else None
    if timing is not None:
        if timing.start_ms is not None:
            node.start = Metric.exact(timing.start_ms)
        if timing.end_ms is not None:
            node.end = Metric.exact(timing.end_ms)
        if timing.start_ms is not None and timing.end_ms is not None:
            node.duration = Metric.exact(timing.end_ms - timing.start_ms)
        node.success = timing.success
    return node


def _build_turn(
    request: RawRequest,
    main_calls: list[LlmCall] | None,
    transcript: Transcript | None,
    debug_log: DebugLog | None,
    usd_per_credit: float,
    source_stream_id: str | None,
) -> Node:
    nodes_by_id = {
        tc.tool_call_id: _build_tool_node(tc, transcript, usd_per_credit, source_stream_id) for tc in request.tool_calls
    }
    children_by_parent: dict[str | None, list[Node]] = {}
    for tool_call in request.tool_calls:
        # An orphan parent id (naming no tool call in this request) is treated as a direct child of the turn.
        parent_id = tool_call.parent_tool_call_id
        if parent_id is not None and parent_id not in nodes_by_id:
            parent_id = None
        children_by_parent.setdefault(parent_id, []).append(nodes_by_id[tool_call.tool_call_id])

    for tool_call in request.tool_calls:
        node = nodes_by_id[tool_call.tool_call_id]
        node.children = children_by_parent.get(tool_call.tool_call_id, [])
        if node.kind is NodeKind.AGENT:
            child_stream_id = tool_call.tool_call_id
            _set_llm_calls(
                node, _llm_calls(tool_call.tool_call_id, transcript, debug_log, child_stream_id, usd_per_credit)
            )

    turn = Node(
        node_id=request.request_id,
        kind=NodeKind.TURN,
        topic=request.text,
        prompt=request.text,
        model=request.model_id,
        children=children_by_parent.get(None, []),
        start=Metric.exact(request.timestamp_ms),
        cost_total=credits_cost(request.credits, usd_per_credit),
        user_wait=(
            Metric.exact(request.time_spent_waiting_ms)
            if request.time_spent_waiting_ms is not None
            else Metric.not_available()
        ),
    )
    if request.elapsed_ms is not None:
        turn.end = Metric.exact(request.timestamp_ms + request.elapsed_ms)
        turn.duration = Metric.exact(request.elapsed_ms)
    _set_llm_calls(turn, main_calls)
    _populate_tool_events(turn, transcript, source_stream_id, debug_log)
    return turn


def _populate_tool_events(
    owner: Node, transcript: Transcript | None, source_stream_id: str | None, debug_log: DebugLog | None
) -> None:
    """Attach native tool execution snapshots to the node that directly owns each invocation."""
    agent_key = owner.agent_uuid if owner.kind is NodeKind.AGENT else None
    calls = debug_log.calls.get(agent_key, []) if debug_log is not None else []
    for child in owner.children:
        timing = transcript.tool_timings.get(child.node_id) if transcript is not None else None
        if timing is not None:
            is_delegation = child.tool is not None and child.tool.category.value == "subagent"
            request_ids = {
                call.source_request_id
                for call in calls
                if call.source_request_id and child.node_id in call.requested_tool_ids
            }
            request_id = (
                next(iter(request_ids))
                if len(request_ids) == 1
                else transcript.tool_request_ids.get(child.node_id)
                if transcript is not None
                else None
            )
            events = tool_execution_events(
                invocation_id=child.node_id,
                subject_node_id=child.node_id,
                start=child.start,
                end=child.end,
                result_recorded=timing.completion_recorded,
                success=timing.success if timing.completion_recorded else None,
                delegation=is_delegation,
                start_order=timing.start_order,
                result_order=timing.completion_order,
                source_stream_id=source_stream_id,
                request_id=request_id,
            )
            if timing.start_ms is not None:
                owner.execution_events.append(events[0])
            if timing.completion_recorded:
                consumers = [
                    call
                    for call in calls
                    if call.source_request_id
                    and child.node_id in call.consumed_tool_ids
                    and timing.end_ms is not None
                    and call.start_ms >= timing.end_ms
                ]
                first_start = min((call.start_ms for call in consumers), default=None)
                first_ids = dict.fromkeys(
                    call.source_request_id
                    for call in consumers
                    if call.start_ms == first_start and call.source_request_id is not None
                )
                events[1].links.extend(
                    EventCallLink(source_request_id=request_id, relation="consumed_by", evidence="recorded")
                    for request_id in first_ids
                )
                owner.execution_events.append(events[1])
        if child.kind is NodeKind.AGENT:
            _populate_tool_events(child, transcript, child.agent_uuid, debug_log)
    owner.execution_events.sort(key=lambda event: (event.source_order is None, event.source_order or 0))


def _call_start(call: LlmCall) -> float | None:
    return call.start.value


def build_root(
    raw: RawSession, transcript: Transcript | None, debug_log: DebugLog | None, usd_per_credit: float
) -> Node:
    """Build session -> turn -> agent -> tool; the main agent's LLM calls are split between turns by start time."""
    stream_id = (transcript.session_id if transcript is not None else None) or raw.session_id
    main_calls = _llm_calls(None, transcript, debug_log, stream_id, usd_per_credit)
    groups = split_by_turn(main_calls or [], _call_start, [request.timestamp_ms for request in raw.requests])
    turns = [
        _build_turn(
            request,
            calls if main_calls is not None else None,
            transcript,
            debug_log,
            usd_per_credit,
            stream_id,
        )
        for request, calls in zip(raw.requests, groups, strict=True)
    ]
    root = Node(node_id="session", kind=NodeKind.SESSION, topic=raw.title or "session", children=turns)
    if transcript is not None:
        root.execution_events.extend(
            ExecutionEvent(
                kind="user_input",
                event_id=f"user-input:{message.message_id}" if message.message_id else None,
                start=Metric.exact(message.timestamp_ms),
                source_order=message.source_order,
                source_stream_id=stream_id,
            )
            for message in transcript.user_messages
        )
        _append_unrepresented_tool_events(root, transcript, stream_id)
        root.execution_events.sort(key=lambda event: (event.source_order is None, event.source_order or 0))
    return root


def _append_unrepresented_tool_events(root: Node, transcript: Transcript, source_stream_id: str | None) -> None:
    """Keep source tool records visible when the session tree has no matching invocation node."""
    nodes = list(iter_nodes(root))
    represented_ids = {node.node_id for node in nodes if node.tool is not None}
    for record in transcript.tool_events:
        if record.tool_call_id is not None and record.tool_call_id in represented_ids:
            continue
        owner = next(
            (node for node in nodes if record.owner_id is not None and node.agent_uuid == record.owner_id),
            root,
        )
        is_start = record.kind == "tool.execution_start"
        name_category = tool_info(record.tool_name, {}).category if record.tool_name is not None else None
        events = tool_execution_events(
            invocation_id=record.tool_call_id,
            subject_node_id=None,
            start=Metric.exact(record.timestamp_ms) if is_start else Metric.not_available(),
            end=Metric.exact(record.timestamp_ms) if not is_start else Metric.not_available(),
            result_recorded=not is_start,
            success=record.success,
            delegation=name_category is not None and name_category.value == "subagent",
            start_order=record.source_order if is_start else None,
            result_order=record.source_order if not is_start else None,
            source_stream_id=record.owner_id or source_stream_id,
        )
        owner.execution_events.append(events[0] if is_start else events[1])
