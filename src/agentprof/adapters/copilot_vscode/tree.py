# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Join a parsed Copilot session with its transcript and debug log into a neutral node tree."""

from collections import Counter
from dataclasses import dataclass, replace
from typing import Any

from agentprof.adapters.copilot_vscode.debuglog import DebugLlmCall, DebugLog
from agentprof.adapters.copilot_vscode.ownership import OwnerDecision, OwnershipContext, decide_owner
from agentprof.adapters.copilot_vscode.session import RawRequest, RawSession, RawToolCall
from agentprof.adapters.copilot_vscode.tools import is_subagent_tool_id, tool_info
from agentprof.adapters.copilot_vscode.transcript import NativeTranscriptRecord, Transcript
from agentprof.adapters.execution import tool_execution_events
from agentprof.adapters.timestamps import parse_iso_ms
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
    TranscriptBlock,
    TranscriptCoverage,
    TranscriptEntry,
    TranscriptKind,
    iter_nodes,
    transcript_entry_id,
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
    if call.input_tokens is None or call.cached_tokens is None:
        return Tokens(
            output=_exact_or_not_available(call.output_tokens),
            cache_read=_exact_or_not_available(call.cached_tokens),
        )
    cached = call.cached_tokens
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
    _populate_transcript(root, raw, transcript, debug_log, stream_id)
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


def _record_text_blocks(value: object, native_type: str | None = None) -> list[TranscriptBlock]:
    if isinstance(value, str):
        return [TranscriptBlock(kind="message", native_type=native_type, text=value)]
    if isinstance(value, list):
        blocks: list[TranscriptBlock] = []
        for part in value:
            if not isinstance(part, dict):
                blocks.append(TranscriptBlock(kind="other", data=part, availability="unsupported"))
                continue
            part_value = part.get("type") or part.get("kind")
            part_type = part_value if isinstance(part_value, str) else None
            text = part.get("text")
            if part_type in ("text", "markdown", "markdownContent") and isinstance(text, str):
                blocks.append(TranscriptBlock(kind="message", native_type=part_type, text=text))
            elif part_type in ("text", "markdown", "markdownContent"):
                blocks.append(
                    TranscriptBlock(kind="message", native_type=part_type, data=part, availability="unavailable")
                )
            elif part_type in ("reasoning", "reasoning_summary", "reasoningSummary", "encrypted_reasoning"):
                encrypted_keys = {"encryptedContent", "encrypted_content", "ciphertext"}
                encrypted = (
                    part_type == "encrypted_reasoning"
                    or part.get("encrypted") is True
                    or any(key in part for key in encrypted_keys)
                )
                blocks.append(
                    TranscriptBlock(
                        kind="reasoning",
                        native_type=part_type,
                        text=None if encrypted else text if isinstance(text, str) else None,
                        data=(
                            {key: item for key, item in part.items() if key not in encrypted_keys | {"text", "content"}}
                            if encrypted
                            else part
                            if not isinstance(text, str)
                            else None
                        ),
                        availability=(
                            "encrypted" if encrypted else "recorded" if isinstance(text, str) else "unavailable"
                        ),
                    )
                )
            else:
                blocks.append(
                    TranscriptBlock(
                        kind="other",
                        native_type=part_type,
                        text=text if isinstance(text, str) else None,
                        data=part,
                        availability="unsupported",
                    )
                )
        return blocks
    return [TranscriptBlock(kind="other", native_type=native_type, data=value, availability="unsupported")]


def _linked_transcript_event_id(
    event_type: object,
    native_event_id: str | None,
    tool_call_id: object,
    event_id_counts: Counter[str],
    tool_start_counts: Counter[str],
    tool_complete_counts: Counter[str],
    owner_id: str | None,
    execution_event_ids: set[str],
) -> str | None:
    if event_type == "user.message" and owner_id is None and native_event_id and event_id_counts[native_event_id] == 1:
        candidate = f"user-input:{native_event_id}"
    elif (
        event_type == "tool.execution_start" and isinstance(tool_call_id, str) and tool_start_counts[tool_call_id] == 1
    ):
        candidate = f"tool-start:{tool_call_id}"
    elif (
        event_type == "tool.execution_complete"
        and isinstance(tool_call_id, str)
        and tool_complete_counts[tool_call_id] == 1
    ):
        candidate = f"tool-result:{tool_call_id}"
    else:
        return None
    return candidate if candidate in execution_event_ids else None


def _set_coverage(
    nodes: list[Node], raw: RawSession, transcript: Transcript | None, debug_log: DebugLog | None
) -> None:
    """Give every node the session's transcript coverage."""
    source_present = transcript is not None or raw.source_present or debug_log is not None
    categories = []
    if transcript is not None:
        categories.append("transcript")
    if raw.source_present:
        categories.append("export")
    if debug_log is not None:
        categories.append("debug-log")
    reasons = [] if transcript is not None else ["transcript_file_missing"]
    coverage = TranscriptCoverage(source_present=source_present, categories=categories, reasons=reasons)
    for node in nodes:
        node.transcript_coverage = TranscriptCoverage(
            source_present=coverage.source_present,
            categories=list(coverage.categories),
            reasons=list(coverage.reasons),
        )


@dataclass(frozen=True)
class _NativeCounts:
    """How often ids occur among the native transcript records; only ids seen once are trusted."""

    message_ids: Counter[str]
    event_ids: Counter[str]
    tool_starts: Counter[str]
    tool_completes: Counter[str]


def _native_counts(records: list[NativeTranscriptRecord]) -> _NativeCounts:
    """Count message ids, event ids and tool starts and completes over the native records."""
    message_id_counts: Counter[str] = Counter()
    event_id_counts: Counter[str] = Counter()
    tool_start_counts: Counter[str] = Counter()
    tool_complete_counts: Counter[str] = Counter()
    for native_record in records:
        native_data = native_record.event.get("data")
        if isinstance(native_data, dict):
            message_id = native_data.get("messageId")
            if isinstance(message_id, str):
                message_id_counts[message_id] += 1
            call_id = native_data.get("toolCallId")
            if isinstance(call_id, str) and native_record.event.get("type") == "tool.execution_start":
                tool_start_counts[call_id] += 1
            if isinstance(call_id, str) and native_record.event.get("type") == "tool.execution_complete":
                tool_complete_counts[call_id] += 1
        native_event_id = native_record.event.get("id")
        if isinstance(native_event_id, str):
            event_id_counts[native_event_id] += 1
    return _NativeCounts(message_id_counts, event_id_counts, tool_start_counts, tool_complete_counts)


@dataclass(frozen=True)
class _EntryLookups:
    """The per-session lookups every native transcript entry is built from."""

    stream: str
    source_stream_id: str | None
    counts: _NativeCounts
    unique_node_ids: dict[str, Node | None]
    execution_event_ids: set[str]


def _entry_kind_and_blocks(
    event_type: object, data: dict[str, Any]
) -> tuple[TranscriptKind, list[TranscriptBlock], str | None, str | None]:
    """The entry kind, blocks, invocation id and delegated child id of one record."""
    entry_kind: TranscriptKind = "other"
    blocks: list[TranscriptBlock] = []
    invocation_id: str | None = None
    delegation_child_id: str | None = None
    if event_type == "user.message":
        entry_kind = "user_message"
        blocks = (
            _record_text_blocks(data.get("content"))
            if "content" in data
            else [TranscriptBlock(kind="message", availability="unavailable")]
        )
    elif event_type == "assistant.message":
        entry_kind = "assistant_message"
        content = data.get("content")
        blocks = (
            _record_text_blocks(content)
            if "content" in data
            else [TranscriptBlock(kind="message", availability="unavailable")]
        )
    elif event_type == "tool.execution_start":
        entry_kind = "tool_request"
        tool_id = data.get("toolCallId")
        invocation_id = tool_id if isinstance(tool_id, str) else None
        blocks = [
            TranscriptBlock(kind="tool_request", native_type="arguments", data=data["arguments"])
            if "arguments" in data
            else TranscriptBlock(kind="tool_request", native_type="arguments", availability="unavailable")
        ]
        tool_name = data.get("toolName")
        if isinstance(tool_name, str) and is_subagent_tool_id(tool_name) and isinstance(tool_id, str):
            delegation_child_id = tool_id
    elif event_type == "tool.execution_complete":
        entry_kind = "tool_result"
        tool_id = data.get("toolCallId")
        invocation_id = tool_id if isinstance(tool_id, str) else None
        output_key = next((key for key in ("output", "result", "content") if key in data), None)
        if output_key is None:
            blocks = [TranscriptBlock(kind="tool_result", availability="unavailable")]
        else:
            value = data[output_key]
            blocks = [
                TranscriptBlock(
                    kind="tool_result",
                    native_type=output_key,
                    text=value if isinstance(value, str) else None,
                    data=None if isinstance(value, str) else value,
                    availability="unavailable" if value is None else "recorded",
                )
            ]
    elif isinstance(event_type, str) and "compact" in event_type.lower():
        entry_kind = "compaction"
        blocks = [TranscriptBlock(kind="compaction", native_type=event_type, data=data)]
    elif event_type in ("session.start", "assistant.turn_start", "assistant.turn_end"):
        entry_kind = "message"
        blocks = [TranscriptBlock(kind="other", native_type=str(event_type), data=data)]
    else:
        blocks = [TranscriptBlock(kind="other", native_type=str(event_type), data=data)]
    return entry_kind, blocks, invocation_id, delegation_child_id


def _entry_node(
    decision: OwnerDecision,
    event_type: object,
    tool_call_id: object,
    agents: dict[str, Node],
    root: Node,
    start_owner: dict[str, str | None],
    start_parent_node: dict[str, Node],
    invocation_parent_nodes: dict[str, Node],
) -> Node:
    """The node a record's entry is attached to: its owner, or the tool call's parent node."""
    node = agents.get(decision.owner_key, root) if decision.owner_key is not None else root
    if (
        event_type == "tool.execution_complete"
        and isinstance(tool_call_id, str)
        and not decision.ambiguous
        and not decision.ambiguous_invocation
        and (decision.has_explicit_owner or decision.parent_known or tool_call_id in start_owner)
    ):
        node = start_parent_node.get(tool_call_id, node)
    if (
        event_type == "tool.execution_start"
        and isinstance(tool_call_id, str)
        and not decision.ambiguous
        and not decision.ambiguous_invocation
    ):
        node = invocation_parent_nodes.get(tool_call_id, node)
    return node


def _native_entry(
    record: NativeTranscriptRecord,
    decision: OwnerDecision,
    node: Node,
    lookups: _EntryLookups,
    entry_kind: TranscriptKind,
    blocks: list[TranscriptBlock],
    invocation_id: str | None,
) -> TranscriptEntry:
    """One transcript entry for a native record."""
    event = record.event
    data_value = event.get("data")
    data: dict[str, Any] = data_value if isinstance(data_value, dict) else {}
    event_type = event.get("type")
    tool_call_id = data.get("toolCallId")
    counts = lookups.counts
    event_id = event.get("id") if isinstance(event.get("id"), str) else None
    source_request_id = data.get("messageId")
    if isinstance(source_request_id, str) is False:
        source_request_id = None
    if source_request_id is not None and counts.message_ids[source_request_id] != 1:
        source_request_id = None
    native_id = source_request_id or event_id
    original_message_id = data.get("messageId")
    if isinstance(original_message_id, str):
        native_id = original_message_id
    try:
        timestamp = (
            Metric.exact(parse_iso_ms(event["timestamp"]))
            if isinstance(event.get("timestamp"), str)
            else Metric.not_available()
        )
    except (TypeError, ValueError):
        timestamp = Metric.not_available()
    return TranscriptEntry(
        entry_id=transcript_entry_id(lookups.stream, record.source_position, native_id=native_id),
        owner_id=node.node_id,
        source_stream_id=lookups.stream,
        logical_stream_id=decision.owner_key or lookups.source_stream_id,
        source_position=record.source_position,
        native_id=native_id,
        native_ordinal=record.native_ordinal,
        timestamp=timestamp,
        kind=entry_kind,
        sender=(
            data.get("sender")
            if event_type in {"user.message", "assistant.message"}
            and isinstance(data.get("sender"), str)
            and data.get("sender")
            else data.get("author")
            if event_type in {"user.message", "assistant.message"}
            and isinstance(data.get("author"), str)
            and data.get("author")
            else None
        ),
        recipient=(
            data.get("recipient")
            if event_type in {"user.message", "assistant.message"}
            and isinstance(data.get("recipient"), str)
            and data.get("recipient")
            else None
        ),
        blocks=blocks,
        source_request_id=source_request_id,
        invocation_id=invocation_id,
        event_id=_linked_transcript_event_id(
            event_type,
            event_id,
            tool_call_id,
            counts.event_ids,
            counts.tool_starts,
            counts.tool_completes,
            decision.owner_key,
            lookups.execution_event_ids,
        ),
        subject_node_id=(
            str(data["toolCallId"])
            if isinstance(data.get("toolCallId"), str)
            and lookups.unique_node_ids.get(str(data["toolCallId"])) is not None
            and not decision.ambiguous_invocation
            else None
        ),
        ownership_evidence=decision.evidence,
    )


def _tool_request_entries(
    record: NativeTranscriptRecord, entry: TranscriptEntry, node: Node, lookups: _EntryLookups, tool_requests: list[Any]
) -> list[TranscriptEntry]:
    """The per-request entries of an assistant message's `toolRequests`."""
    entries = []
    for index, request in enumerate(tool_requests, 1):
        if not isinstance(request, dict):
            continue
        tool_id = request.get("toolCallId")
        entries.append(
            TranscriptEntry(
                entry_id=transcript_entry_id(
                    lookups.stream, record.source_position, index, str(tool_id) if tool_id else None
                ),
                owner_id=node.node_id,
                source_stream_id=lookups.stream,
                logical_stream_id=entry.logical_stream_id,
                source_position=record.source_position,
                block_position=index,
                native_id=str(tool_id) if tool_id else entry.native_id,
                native_ordinal=record.native_ordinal,
                timestamp=entry.timestamp,
                kind="delegation" if is_subagent_tool_id(request.get("name")) else "tool_request",
                blocks=[
                    TranscriptBlock(kind="tool_request", native_type=request.get("name"), data=request.get("arguments"))
                ],
                source_request_id=entry.source_request_id if isinstance(entry.source_request_id, str) else None,
                invocation_id=str(tool_id) if isinstance(tool_id, str) else None,
                subject_node_id=(
                    str(tool_id)
                    if isinstance(tool_id, str) and lookups.unique_node_ids.get(str(tool_id)) is not None
                    else None
                ),
                ownership_evidence=entry.ownership_evidence,
            )
        )
    return entries


def _attach_debug_log_entries(
    root: Node, agents: dict[str, Node], debug_log: DebugLog, source_stream_id: str | None
) -> None:
    """Attach debug-log responses and request-history snapshots."""
    call_positions: dict[tuple[str | None, str, str], list[tuple[int, int]]] = {}
    for owner, calls in debug_log.calls.items():
        for index, call in enumerate(calls):
            if call.source_request_id is not None and call.source_filename is not None:
                call_positions.setdefault((owner, call.source_filename, call.source_request_id), []).append(
                    (
                        call.source_position if call.source_position is not None else index,
                        call.native_ordinal if call.native_ordinal is not None else index,
                    )
                )
    for record in debug_log.response_records:
        request_id = record.request_id
        response = record.message
        filename = response.source_filename or "unknown.jsonl"
        positions = call_positions.get((record.owner_id, filename, request_id), [])
        physical_position = response.source_position if response.source_position is not None else 0
        node = agents.get(record.owner_id, root)
        stream = f"copilot-debug:{source_stream_id}:{filename}"
        native_id = response.native_id or f"agent-msg-{request_id}"
        node.transcript_entries.append(
            TranscriptEntry(
                entry_id=transcript_entry_id(stream, physical_position, native_id=native_id),
                owner_id=node.node_id,
                source_stream_id=stream,
                logical_stream_id=record.owner_id or source_stream_id,
                source_position=physical_position,
                native_id=native_id,
                native_ordinal=response.native_ordinal,
                timestamp=(
                    Metric.exact(response.timestamp_ms) if response.timestamp_ms is not None else Metric.not_available()
                ),
                kind="assistant_message",
                role=response.role,
                blocks=[
                    replace(block, availability=response.availability) if block.availability == "recorded" else block
                    for block in response.blocks
                ],
                source_request_id=request_id if len(positions) == 1 else None,
                ownership_evidence="explicit_span",
            )
        )
    for record in debug_log.history_records:
        positions = call_positions.get((record.owner_id, record.source_filename, record.request_id), [])
        node = agents.get(record.owner_id, root)
        stream = f"copilot-debug:{source_stream_id}:{record.source_filename}"
        native_snapshot = [
            {
                "role": message.role,
                "availability": message.availability,
                "blocks": [
                    {
                        "kind": block.kind,
                        "native_type": block.native_type,
                        "text": block.text,
                        "data": block.data,
                        "availability": block.availability,
                    }
                    for block in message.blocks
                ],
            }
            for message in record.messages
        ]
        node.transcript_entries.append(
            TranscriptEntry(
                entry_id=transcript_entry_id(stream, record.source_position, native_id=record.request_id),
                owner_id=node.node_id,
                source_stream_id=stream,
                logical_stream_id=record.owner_id or source_stream_id,
                source_position=record.source_position,
                native_id=record.request_id,
                native_ordinal=record.native_ordinal,
                timestamp=(
                    Metric.exact(record.timestamp_ms) if record.timestamp_ms is not None else Metric.not_available()
                ),
                kind="other",
                channel="request_history_snapshot",
                blocks=[TranscriptBlock(kind="other", native_type="inputMessages", data=native_snapshot)],
                source_request_id=record.request_id if len(positions) == 1 else None,
                ownership_evidence="explicit_span_snapshot",
            )
        )


def _populate_transcript(
    root: Node,
    raw: RawSession,
    transcript: Transcript | None,
    debug_log: DebugLog | None,
    source_stream_id: str | None,
) -> None:
    nodes = list(iter_nodes(root))
    unique_node_ids: dict[str, Node | None] = {}
    for node in nodes:
        unique_node_ids[node.node_id] = node if node.node_id not in unique_node_ids else None
    agents = {
        node.agent_uuid: node
        for node in nodes
        if node.agent_uuid is not None and unique_node_ids.get(node.agent_uuid) is node
    }
    parent_nodes: dict[str, Node | None] = {}
    node_index: dict[str, Node | None] = {}
    for node in nodes:
        node_index[node.node_id] = node if node.node_id not in node_index else None
        for child in node.children:
            parent_nodes[child.node_id] = node if child.node_id not in parent_nodes else None
    invocation_parent_nodes: dict[str, Node] = {}
    invocation_owners: dict[str, str | None] = {}
    for candidate in nodes:
        parent = parent_nodes.get(candidate.node_id)
        if candidate.tool is not None and node_index.get(candidate.node_id) is candidate and parent is not None:
            invocation_parent_nodes[candidate.node_id] = parent
            invocation_owners[candidate.node_id] = parent.agent_uuid
    _set_coverage(nodes, raw, transcript, debug_log)

    _populate_export_entries(root, raw, source_stream_id)

    stream = (
        f"copilot-transcript:{transcript.session_id or source_stream_id}:{transcript.source_filename}"
        if transcript is not None
        else f"copilot-export:{raw.session_id or source_stream_id}"
    )
    if transcript is not None:
        counts = _native_counts(transcript.native_records)
        lookups = _EntryLookups(
            stream=stream,
            source_stream_id=source_stream_id,
            counts=counts,
            unique_node_ids=unique_node_ids,
            execution_event_ids={
                event.event_id for node in nodes for event in node.execution_events if event.event_id is not None
            },
        )
        context = OwnershipContext(
            root_sid=transcript.session_id,
            agents=frozenset(agents),
            invocation_owners=invocation_owners,
            ambiguous_tool_ids=frozenset(
                {tool_id for tool_id, count in counts.tool_starts.items() if count > 1}
                | {node_id for node_id, indexed in node_index.items() if indexed is None}
            ),
            event_id_counts=counts.event_ids,
        )
        start_parent_node: dict[str, Node] = {}
        for record in transcript.native_records:
            event = record.event
            data_value = event.get("data")
            data: dict[str, Any] = data_value if isinstance(data_value, dict) else {}
            event_type = event.get("type")
            tool_call_id = data.get("toolCallId")
            decision = decide_owner(event, context)
            node = _entry_node(
                decision,
                event_type,
                tool_call_id,
                agents,
                root,
                context.start_owner,
                start_parent_node,
                invocation_parent_nodes,
            )
            entry_kind, blocks, invocation_id, delegation_child_id = _entry_kind_and_blocks(event_type, data)
            entry = _native_entry(record, decision, node, lookups, entry_kind, blocks, invocation_id)
            node.transcript_entries.append(entry)
            if (
                event_type == "tool.execution_start"
                and isinstance(tool_call_id, str)
                and not decision.ambiguous
                and not decision.ambiguous_invocation
            ):
                start_parent_node[tool_call_id] = node
            context.observe(event, decision, delegation_child_id)
            if event_type == "assistant.message" and isinstance(data.get("toolRequests"), list):
                node.transcript_entries.extend(
                    _tool_request_entries(record, entry, node, lookups, data["toolRequests"])
                )

    if debug_log is not None:
        _attach_debug_log_entries(root, agents, debug_log, source_stream_id)


def _populate_export_entries(root: Node, raw: RawSession, source_stream_id: str | None) -> None:
    stream = f"copilot-export:{raw.session_id or source_stream_id}"
    turns = {node.node_id: node for node in root.children}
    node_ids: dict[str, Node | None] = {}
    parent_by_id: dict[str, Node] = {}

    def index(node: Node) -> None:
        node_ids[node.node_id] = node if node.node_id not in node_ids else None
        for child in node.children:
            parent_by_id[child.node_id] = node
            index(child)

    index(root)
    for request_index, request in enumerate(raw.requests):
        turn = turns.get(request.request_id)
        if turn is None:
            continue
        prompt_blocks = (
            _record_text_blocks(request.prompt_parts)
            if request.prompt_parts
            else [TranscriptBlock(kind="message", text=request.text)]
            if request.prompt_available
            else [TranscriptBlock(kind="message", availability="unavailable")]
        )
        turn.transcript_entries.append(
            TranscriptEntry(
                entry_id=transcript_entry_id(stream, request_index, 0, request.request_id),
                owner_id=turn.node_id,
                source_stream_id=stream,
                logical_stream_id=source_stream_id,
                source_position=request_index,
                block_position=0,
                native_id=request.request_id,
                native_ordinal=request_index,
                timestamp=Metric.exact(request.timestamp_ms),
                kind="user_message",
                role="user",
                blocks=prompt_blocks,
                source_request_id=request.request_id,
                ownership_evidence="export_request",
            )
        )
        calls = {call.tool_call_id: call for call in request.tool_calls}
        for part_index, part in enumerate(request.response_parts, 1):
            part_kind = part.get("kind")
            tool_id = part.get("toolCallId") if isinstance(part.get("toolCallId"), str) else None
            call = calls.get(tool_id) if tool_id is not None else None
            owner = parent_by_id.get(tool_id, turn) if tool_id is not None else turn
            native_id = str(tool_id) if tool_id else part.get("id") if isinstance(part.get("id"), str) else None
            kind = "tool_request" if part_kind == "toolInvocationSerialized" else "assistant_message"
            if isinstance(part_kind, str) and "reason" in part_kind.lower():
                kind = "reasoning"
            if kind == "tool_request":
                block = TranscriptBlock(kind="tool_request", native_type=str(part_kind), data=part)
            elif kind == "reasoning":
                encrypted_keys = {"encryptedContent", "encrypted_content", "ciphertext"}
                encrypted = part.get("encrypted") is True or any(key in part for key in encrypted_keys)
                value = next((part[key] for key in ("text", "content") if isinstance(part.get(key), str)), None)
                block = TranscriptBlock(
                    kind="reasoning",
                    native_type=str(part_kind),
                    text=None if encrypted else value,
                    data=(
                        {key: item for key, item in part.items() if key not in encrypted_keys | {"text", "content"}}
                        if encrypted
                        else None
                        if isinstance(value, str)
                        else part
                    ),
                    availability=(
                        "encrypted" if encrypted else "recorded" if isinstance(value, str) else "unavailable"
                    ),
                )
            else:
                value = next((part[key] for key in ("text", "value", "content", "markdown") if key in part), None)
                text_part = part_kind in ("text", "markdown", "markdownContent")
                block = TranscriptBlock(
                    kind="message" if isinstance(value, str) or text_part else "other",
                    native_type=str(part_kind),
                    text=value if isinstance(value, str) else None,
                    data=None if isinstance(value, str) else part,
                    availability=(
                        "recorded" if isinstance(value, str) else "unavailable" if text_part else "unsupported"
                    ),
                )
            part_position = part_index * 3
            owner.transcript_entries.append(
                TranscriptEntry(
                    entry_id=transcript_entry_id(stream, request_index, part_position, native_id),
                    owner_id=owner.node_id,
                    source_stream_id=stream,
                    logical_stream_id=owner.agent_uuid or source_stream_id,
                    source_position=request_index,
                    block_position=part_position,
                    native_id=native_id,
                    native_ordinal=part_index,
                    timestamp=Metric.exact(request.timestamp_ms),
                    kind="delegation" if call is not None and call.is_agent else kind,
                    role="assistant",
                    blocks=[block],
                    source_request_id=request.request_id,
                    invocation_id=tool_id,
                    subject_node_id=tool_id if node_ids.get(tool_id or "") is not None else None,
                    ownership_evidence="explicit_invocation_parent" if tool_id is not None else "export_request",
                )
            )
            if call is None or not call.is_agent:
                continue
            child = node_ids.get(call.tool_call_id)
            if child is None:
                continue
            for offset, (label, content) in enumerate(
                (("subagent_prompt", call.subagent_prompt), ("subagent_result", call.subagent_result)), 1
            ):
                if not isinstance(content, str):
                    continue
                child.transcript_entries.append(
                    TranscriptEntry(
                        entry_id=transcript_entry_id(stream, request_index, part_position + offset, call.tool_call_id),
                        owner_id=child.node_id,
                        source_stream_id=stream,
                        logical_stream_id=child.agent_uuid,
                        source_position=request_index,
                        block_position=part_position + offset,
                        native_id=call.tool_call_id,
                        native_ordinal=part_index,
                        timestamp=Metric.exact(request.timestamp_ms),
                        kind="user_message" if label == "subagent_prompt" else "assistant_message",
                        role="user" if label == "subagent_prompt" else "assistant",
                        blocks=[TranscriptBlock(kind="message", native_type=label, text=content)],
                        invocation_id=call.tool_call_id,
                        ownership_evidence="export_child_scope",
                    )
                )


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
