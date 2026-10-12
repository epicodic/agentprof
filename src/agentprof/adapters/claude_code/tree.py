# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Build the neutral node tree from a Claude Code main transcript and its subagent transcripts."""

import json
import re
from bisect import bisect_right
from typing import Any

from agentprof.adapters.claude_code.discovery import Subagent
from agentprof.adapters.claude_code.prompts import first_line, prompt_topic
from agentprof.adapters.claude_code.tools import tool_info
from agentprof.adapters.claude_code.transcript import (
    AssistantMessage,
    NativeRecord,
    Prompt,
    ToolResult,
    ToolUse,
    Transcript,
)
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
    ToolCategory,
    TranscriptBlock,
    TranscriptCoverage,
    TranscriptEntry,
    TranscriptKind,
    iter_nodes,
    transcript_entry_id,
)
from agentprof.pricing import PriceTable, Usage

_ASK_USER_TOOL = "AskUserQuestion"
_TOPIC_KEYS = ("description", "file_path", "notebook_path", "command", "pattern", "url", "query")
_TOPIC_LENGTH = 200
_SYNTHETIC_TURN_ID = "turn-1"
# Claude Code's own placeholder messages (e.g. an interrupted request); they carry no real context.
_SYNTHETIC_MODEL = "<synthetic>"
_ASYNC_AGENT_LAUNCH = "Async agent launched successfully."
_SEND_MESSAGE_TOOL = "sendmessage"
_TEAMMATE_MESSAGE_RE = re.compile(
    r'^\s*<teammate-message(?P<attributes>(?:\s+[A-Za-z_][\w.-]*="[^"<>]*")*)\s*>'
    r"(?P<body>.*?)</teammate-message>\s*$",
    re.DOTALL,
)
_TEAMMATE_ATTRIBUTE_RE = re.compile(r'\s+([A-Za-z_][\w.-]*)="([^"<>]*)"')
_MESSAGE_PREVIEW_LENGTH = 80
_TARGET_PREVIEW_LENGTH = 60


def _count(source: object, key: str) -> int:
    value = source.get(key) if isinstance(source, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def usage_of(usage: dict[str, Any]) -> Usage:
    """Token counts of one call; cache writes without a 5m/1h split are counted at the 5-minute rate."""
    cache_write = _count(usage, "cache_creation_input_tokens")
    one_hour = _count(usage.get("cache_creation"), "ephemeral_1h_input_tokens")
    return Usage(
        input=_count(usage, "input_tokens"),
        output=_count(usage, "output_tokens"),
        cache_read=_count(usage, "cache_read_input_tokens"),
        cache_write_5m=max(0, cache_write - one_hour),
        cache_write_1h=one_hour,
    )


def message_cost(message: AssistantMessage, prices: PriceTable) -> CostMetric:
    """Estimated cost of one assistant message; `n/a` without usage or a price for its model."""
    if not message.usage:
        return CostMetric.not_available()
    return prices.cost(message.model, usage_of(message.usage))


def _llm_call(message: AssistantMessage, prices: PriceTable, source_stream_id: str | None = None) -> LlmCall:
    call = LlmCall(
        start=Metric.exact(message.start_ms),
        model=message.model,
        in_context=message.model != _SYNTHETIC_MODEL,
        call_id=message.message_id,
        source_request_id=message.message_id,
        source_order=message.source_order,
        source_stream_id=source_stream_id,
        timing_basis="assistant_message",
        price_prefix=prices.matching_prefix(message.model),
    )
    if not message.usage:
        return call
    usage = usage_of(message.usage)
    call.tokens = Tokens(
        input=Metric.exact(usage.input),
        output=Metric.exact(usage.output),
        cache_read=Metric.exact(usage.cache_read),
        cache_write=Metric.exact(usage.cache_write_5m + usage.cache_write_1h),
    )
    split = message.usage.get("cache_creation")
    if (
        isinstance(split, dict)
        and isinstance(split.get("ephemeral_5m_input_tokens"), int)
        and isinstance(split.get("ephemeral_1h_input_tokens"), int)
        and not isinstance(split["ephemeral_5m_input_tokens"], bool)
        and not isinstance(split["ephemeral_1h_input_tokens"], bool)
        and split["ephemeral_5m_input_tokens"] + split["ephemeral_1h_input_tokens"]
        == _count(message.usage, "cache_creation_input_tokens")
    ):
        call.tokens.cache_write_5m = Metric.exact(split["ephemeral_5m_input_tokens"])
        call.tokens.cache_write_1h = Metric.exact(split["ephemeral_1h_input_tokens"])
    call.cost = message_cost(message, prices)
    call.cost_parts = prices.cost_parts(message.model, usage)
    if call.tokens.cache_write_5m.value is None:
        call.cost_parts["cache_write_5m"] = CostMetric.not_available()
        call.cost_parts["cache_write_1h"] = CostMetric.not_available()
    return call


def _topic(tool_use: ToolUse) -> str:
    if tool_use.name.casefold() == _SEND_MESSAGE_TOOL:
        target = tool_use.input.get("target") or tool_use.input.get("to") or tool_use.input.get("recipient")
        message = tool_use.input.get("message") or tool_use.input.get("content")
        target_preview = first_line(target, _TARGET_PREVIEW_LENGTH) if isinstance(target, str) else ""
        message_preview = first_line(message, _MESSAGE_PREVIEW_LENGTH) if isinstance(message, str) else ""
        topic = f"SendMessage to {target_preview}" if target_preview else "SendMessage"
        return f"{topic}: {message_preview}" if message_preview else topic
    for key in _TOPIC_KEYS:
        value = tool_use.input.get(key)
        if isinstance(value, str) and value:
            return f"{tool_use.name}: {first_line(value, _TOPIC_LENGTH)}"
    return tool_use.name


def _resume_agent_id(text: str, target: str | None) -> str | None:
    """Return the exact harness ID confirmed by a SendMessage result, when known."""
    match = re.search(r"(?:^|\n)Resuming agent ([A-Za-z0-9_-]+)(?:\s|$)", text)
    if match is not None:
        return match.group(1)
    try:
        result = json.loads(text)
    except ValueError:
        return None
    if isinstance(result, dict) and (result.get("resumed") is True or result.get("status") == "resumed"):
        return target
    if isinstance(result, dict) and result.get("success") is True:
        resumed_id = result.get("resumedAgentId")
        if isinstance(resumed_id, str) and resumed_id:
            return resumed_id
    return None


def _tool_node(tool_use: ToolUse, transcript: Transcript) -> Node:
    node = Node(
        node_id=tool_use.tool_use_id,
        kind=NodeKind.TOOL,
        topic=_topic(tool_use),
        tool=tool_info(tool_use.name, tool_use.input),
        start=Metric.exact(tool_use.start_ms),
    )
    result = transcript.tool_results.get(tool_use.tool_use_id)
    if node.tool is not None and tool_use.name.casefold() == _SEND_MESSAGE_TOOL:
        target = tool_use.input.get("target") or tool_use.input.get("to") or tool_use.input.get("recipient")
        node.tool.target_agent_id = target if isinstance(target, str) and target else None
        if result is not None and not result.is_error:
            resumed_id = _resume_agent_id(result.text, node.tool.target_agent_id)
            node.tool.is_resume = resumed_id is not None
            if resumed_id is not None:
                node.tool.target_agent_id = resumed_id
    if result is not None:
        node.end = Metric.exact(result.end_ms)
        node.duration = Metric.exact(result.end_ms - tool_use.start_ms)
        node.success = not result.is_error
        node.result = result.text
    return node


def _last_activity_ms(transcript: Transcript) -> int | None:
    times = [message.start_ms for message in transcript.messages]
    times += [result.end_ms for result in transcript.tool_results.values()]
    return max(times, default=None)


class _TreeBuilder:
    """Creates one tool node per tool call across all transcripts, then links them into agents.

    Every tool call of every transcript is indexed up front, so `attach` can find a spawning `Agent` call in any
    file. `attach` turns that tool node into an agent node in place; the node may already sit in another agent's
    `children`, which is intended: the tree shares these node objects instead of copying them.
    """

    def __init__(self, transcripts: list[Transcript], prices: PriceTable) -> None:
        self._prices = prices
        self._nodes: dict[str, Node] = {}
        self._placed: set[str] = set()
        self._agents_by_harness_id: dict[str, list[Node]] = {}
        self._transcript_owners: dict[int, Node] = {}
        self.orphans: list[Node] = []
        for transcript in transcripts:
            for tool_use in transcript.tool_uses:
                self._nodes.setdefault(tool_use.tool_use_id, _tool_node(tool_use, transcript))

    def take(self, transcript: Transcript) -> list[Node]:
        """The tool nodes of `transcript` that no other agent has claimed yet."""
        taken: list[Node] = []
        for tool_use in transcript.tool_uses:
            if tool_use.tool_use_id not in self._placed:
                self._placed.add(tool_use.tool_use_id)
                taken.append(self._nodes[tool_use.tool_use_id])
        return taken

    def calls(self, transcript: Transcript) -> list[LlmCall]:
        return [_llm_call(message, self._prices, transcript.source_stream_id) for message in transcript.messages]

    def attach(self, subagent: Subagent) -> None:
        """Turn the spawning tool node into the subagent's agent node, or create an orphan agent node."""
        meta, transcript = subagent.meta, subagent.transcript
        own_ids = {tool_use.tool_use_id for tool_use in transcript.tool_uses}
        node = self._nodes.get(meta.tool_use_id) if meta.tool_use_id and meta.tool_use_id not in own_ids else None
        if node is None:
            node = Node(node_id=f"agent-{meta.agent_id}", kind=NodeKind.AGENT, topic=meta.agent_id)
            if transcript.first_timestamp_ms is not None:
                node.start = Metric.exact(transcript.first_timestamp_ms)
            self.orphans.append(node)
        elif node.result.startswith(_ASYNC_AGENT_LAUNCH):
            # This is an acknowledgement that a background agent started, not its terminal result.
            node.end = Metric.not_available()
            node.duration = Metric.not_available()
        node.kind = NodeKind.AGENT
        self._transcript_owners[id(transcript)] = node
        node.agent_uuid = meta.agent_id
        self._agents_by_harness_id.setdefault(meta.agent_id, []).append(node)
        if meta.description:
            node.topic = meta.description
        node.llm_calls = self.calls(transcript)
        node.llm_call_count = Metric.exact(len(node.llm_calls))
        node.compactions = [Metric.exact(ms) for ms in transcript.compactions_ms]
        node.execution_events.extend(
            ExecutionEvent(
                kind="compaction",
                subject_node_id=node.node_id,
                start=Metric.exact(ms),
                source_stream_id=transcript.source_stream_id,
            )
            for ms in transcript.compactions_ms
        )
        node.model = next((call.model for call in node.llm_calls if call.model), None) or meta.model
        if transcript.prompts:
            node.prompt = transcript.prompts[0].text
        node.children = self.take(transcript)
        last_ms = _last_activity_ms(transcript)
        if last_ms is not None and node.end.value is not None and last_ms > node.end.value:
            node.end = Metric.exact(last_ms)
            node.duration = Metric.exact(last_ms - node.start.number())

    def link_resumes(self) -> None:
        """Link confirmed messages only when their exact harness target identifies one agent."""
        for node in self._nodes.values():
            info = node.tool
            if info is None or not info.is_resume or info.target_agent_id is None:
                continue
            matches = self._agents_by_harness_id.get(info.target_agent_id, [])
            if len(matches) != 1:
                continue
            agent = matches[0]
            info.linked_agent_node_id = agent.node_id
            agent.resume_times.append(node.start)
            agent.execution_events.append(
                ExecutionEvent(kind="resume", subject_node_id=agent.node_id, start=node.start)
            )


def _item_start(item: Node | LlmCall) -> float | None:
    return item.start.value


def _ms_start(ms: int) -> float:
    return float(ms)


def _turn(
    prompt: Prompt,
    children: list[Node],
    calls: list[LlmCall],
    compactions: list[int],
    source_stream_id: str | None,
) -> Node:
    waits = [
        child.duration.number()
        for child in children
        if child.tool is not None and child.tool.native_id == _ASK_USER_TOOL and child.duration.value is not None
    ]
    return Node(
        node_id=prompt.uuid,
        kind=NodeKind.TURN,
        topic=prompt_topic(prompt.text),
        prompt=prompt.text,
        model=next((call.model for call in calls if call.model), None),
        start=Metric.exact(prompt.start_ms),
        children=children,
        llm_calls=calls,
        llm_call_count=Metric.exact(len(calls)),
        user_wait=Metric.estimated(sum(waits)),
        compactions=[Metric.exact(ms) for ms in compactions],
        execution_events=[
            ExecutionEvent(
                kind="compaction",
                subject_node_id=prompt.uuid,
                start=Metric.exact(ms),
                source_stream_id=source_stream_id,
            )
            for ms in compactions
        ],
    )


def _parent_nodes(root: Node) -> dict[int, Node]:
    parents: dict[int, Node] = {}

    def visit(parent: Node) -> None:
        for child in parent.children:
            parents[id(child)] = parent
            visit(child)

    visit(root)
    return parents


def _turn_at(turns: list[Node], timestamp_ms: int) -> Node | None:
    candidates = [turn for turn in turns if turn.start.value is not None and turn.start.number() <= timestamp_ms]
    return candidates[-1] if candidates else (turns[0] if turns else None)


def _record_owner_linear(
    record: NativeRecord,
    prompts: list[Prompt],
    turns: list[Node],
    root: Node,
) -> Node:
    if not prompts or len(prompts) != len(turns) or record.source_position < (prompts[0].source_position or 0):
        return root
    matching = [
        index
        for index, prompt in enumerate(prompts)
        if prompt.source_position is not None and prompt.source_position <= record.source_position
    ]
    return turns[matching[-1]] if matching else root


def _record_owners(
    records: list[NativeRecord],
    prompts: list[Prompt],
    turns: list[Node],
    root: Node,
) -> list[Node]:
    if not prompts or len(prompts) != len(turns):
        return [root for _ in records]
    positions = [
        (prompt.source_position, index) for index, prompt in enumerate(prompts) if prompt.source_position is not None
    ]
    if any(positions[index][0] > positions[index + 1][0] for index in range(len(positions) - 1)):
        return [_record_owner_linear(record, prompts, turns, root) for record in records]
    position_values = [position for position, _ in positions]
    first_position = prompts[0].source_position or 0
    owners: list[Node] = []
    for record in records:
        if record.source_position < first_position:
            owners.append(root)
            continue
        index = bisect_right(position_values, record.source_position) - 1
        owners.append(turns[positions[index][1]] if index >= 0 else root)
    return owners


def _native_entry(
    record: NativeRecord,
    block: TranscriptBlock,
    block_position: int,
    owner: Node,
    transcript: Transcript,
) -> TranscriptEntry:
    kind: TranscriptKind = record.kind
    invocation_id: str | None = None
    if block.kind == "reasoning":
        kind = "reasoning"
    elif block.kind == "tool_request":
        kind = "tool_request"
        data = block.data
        invocation_id = str(data["id"]) if isinstance(data, dict) and data.get("id") is not None else None
        if isinstance(data, dict) and isinstance(data.get("name"), str):
            raw_input = data.get("input")
            if (
                tool_info(data["name"], raw_input if isinstance(raw_input, dict) else {}).category
                is ToolCategory.SUBAGENT
            ):
                kind = "delegation"
    elif block.kind == "tool_result":
        kind = "tool_result"
        data = block.data
        invocation_id = (
            str(data["tool_use_id"]) if isinstance(data, dict) and data.get("tool_use_id") is not None else None
        )
    elif record.kind != "compaction":
        kind = "user_message" if record.entry_type == "user" else "assistant_message"
    sender = None
    if record.entry_type == "user":
        body = block.text
        if body is not None and (match := _TEAMMATE_MESSAGE_RE.fullmatch(body)) is not None:
            teammate_ids = [
                value
                for name, value in _TEAMMATE_ATTRIBUTE_RE.findall(match.group("attributes"))
                if name == "teammate_id"
            ]
            if len(teammate_ids) == 1 and teammate_ids[0]:
                sender = teammate_ids[0]
    recipient = None
    if block.kind == "tool_request" and isinstance(block.data, dict):
        name = block.data.get("name")
        tool_input = block.data.get("input")
        if isinstance(name, str) and name.casefold() == _SEND_MESSAGE_TOOL and isinstance(tool_input, dict):
            target = tool_input.get("recipient")
            recipient = target if isinstance(target, str) and target else None
    stream_id = transcript.native_source_stream_id or transcript.source_stream_id or "claude-code:unknown"
    return TranscriptEntry(
        entry_id=transcript_entry_id(stream_id, record.source_position, block_position, record.native_id),
        owner_id=owner.node_id,
        source_stream_id=stream_id,
        source_position=record.source_position,
        logical_stream_id=transcript.source_stream_id,
        block_position=block_position,
        native_id=record.native_id,
        native_ordinal=record.source_order,
        timestamp=Metric.exact(record.timestamp_ms) if record.timestamp_ms is not None else Metric.not_available(),
        kind=kind,
        role=record.role,
        sender=sender,
        recipient=recipient,
        channel=record.channel,
        blocks=[block],
        source_request_id=record.source_request_id,
        invocation_id=invocation_id,
    )


def _attach_native_transcripts(
    root: Node,
    main: Transcript,
    subagents: list[Subagent],
    turns: list[Node],
    builder: _TreeBuilder,
) -> None:
    source_owners: list[tuple[Transcript, Node, list[tuple[NativeRecord, Node]]]] = []
    main_owners = _record_owners(main.native_records, main.prompts, turns, root)
    main_records = list(zip(main.native_records, main_owners, strict=True))
    source_owners.append((main, root, main_records))
    for subagent in subagents:
        owner = builder._transcript_owners.get(id(subagent.transcript))
        if owner is not None:
            source_owners.append(
                (subagent.transcript, owner, [(record, owner) for record in subagent.transcript.native_records])
            )

    all_events: dict[tuple[str | None, str], list[ExecutionEvent]] = {}
    for node in iter_nodes(root):
        for event in node.execution_events:
            if event.event_id is not None:
                all_events.setdefault((event.source_stream_id, event.event_id), []).append(event)

    for transcript, source_owner, records in source_owners:
        entries_by_owner: dict[int, list[TranscriptEntry]] = {}
        reasons_by_owner: dict[int, set[str]] = {}
        for record, owner in records:
            owner_reasons = reasons_by_owner.setdefault(id(owner), set())
            blocks = record.blocks or []
            indexed_blocks = list(enumerate(blocks)) if blocks else [(0, None)]
            for block_position, block in indexed_blocks:
                retained_block = block or TranscriptBlock(kind="message")
                entry = _native_entry(record, retained_block, block_position, owner, transcript)
                logical = transcript.source_stream_id
                if entry.invocation_id is not None and logical is not None:
                    event_kind = "tool-result" if entry.kind == "tool_result" else "tool-start"
                    matches = all_events.get((logical, f"{event_kind}:{entry.invocation_id}"), [])
                    exact = [event for event in matches if event.source_order == record.source_order]
                    if len(exact) == 1:
                        entry.event_id = exact[0].event_id
                        entry.subject_node_id = exact[0].subject_node_id
                elif entry.kind == "user_message" and logical is not None and record.native_id is not None:
                    matches = all_events.get((logical, f"user-input:{record.native_id}"), [])
                    exact = [
                        event
                        for event in matches
                        if event.kind == "user_input" and event.source_order == record.source_order
                    ]
                    if len(exact) == 1:
                        entry.event_id = exact[0].event_id
                        entry.subject_node_id = exact[0].subject_node_id
                owner.transcript_entries.append(entry)
                entries_by_owner.setdefault(id(owner), []).append(entry)
                if retained_block.availability == "encrypted":
                    owner_reasons.add("encrypted_content")
                elif retained_block.availability == "unsupported":
                    owner_reasons.add("unsupported_content")
                elif retained_block.availability == "unavailable":
                    owner_reasons.add("unavailable_content")
            if record.timestamp_ms is None:
                owner_reasons.add("missing_timestamps")
        if transcript.malformed_lines:
            reasons_by_owner.setdefault(id(source_owner), set()).add("malformed_lines_skipped")
            for _, owner in records:
                reasons_by_owner.setdefault(id(owner), set()).add("malformed_lines_skipped")
        owners = {id(owner): owner for _, owner in records}
        owners.setdefault(id(source_owner), source_owner)
        for owner_id, owner in owners.items():
            owner.transcript_coverage = TranscriptCoverage(
                source_present=True,
                categories=sorted({entry.kind for entry in entries_by_owner.get(owner_id, [])}),
                reasons=sorted(reasons_by_owner.get(owner_id, set())),
            )

        terminal_text_by_owner: dict[int, tuple[Node, str]] = {}
        for record, owner in records:
            if record.entry_type != "assistant" or record.stop_reason != "end_turn":
                continue
            terminal_blocks = [
                block for block in record.blocks if block.native_type == "text" and block.text is not None
            ]
            if terminal_blocks:
                terminal_text = "\n".join(block.text or "" for block in terminal_blocks)
                terminal_text_by_owner[id(owner)] = (owner, terminal_text)
        for owner, terminal_text in terminal_text_by_owner.values():
            if owner.tool is None and not owner.result:
                owner.result = terminal_text


def _emit_tool_events(
    root: Node,
    transcripts: list[Transcript],
    builder: _TreeBuilder,
    unique_ids: set[str],
) -> None:
    parents = _parent_nodes(root)
    turns = [node for node in root.children if node.kind is NodeKind.TURN]

    def owner_for(transcript: Transcript, timestamp_ms: int, node: Node | None) -> Node | None:
        if node is not None and id(node) in parents:
            return parents[id(node)]
        if any(transcript is candidate for candidate in transcripts[1:]):
            return builder._transcript_owners.get(id(transcript))
        return _turn_at(turns, timestamp_ms) or root

    for transcript in transcripts:
        record_list = transcript.tool_result_records or list(transcript.tool_results.items())
        records_by_id: dict[str, list[tuple[int, ToolResult]]] = {}
        for record_index, (invocation_id, result) in enumerate(record_list):
            records_by_id.setdefault(invocation_id, []).append((record_index, result))

        used_result_records: set[int] = set()
        for tool_use in transcript.tool_uses:
            invocation_id = tool_use.tool_use_id
            node = builder._nodes.get(invocation_id)
            subject_node_id = node.node_id if node is not None and invocation_id in unique_ids else None
            results = records_by_id.get(invocation_id, [])
            last_result = results[-1][1] if results else None
            start = Metric.exact(tool_use.start_ms)
            end = Metric.exact(last_result.end_ms) if last_result is not None else Metric.not_available()
            owner = owner_for(transcript, tool_use.start_ms, node if subject_node_id is not None else None)
            if owner is None:
                continue
            source_tool = tool_info(tool_use.name, tool_use.input)
            delegation = source_tool.category is ToolCategory.SUBAGENT
            start_event = tool_execution_events(
                invocation_id=invocation_id,
                subject_node_id=subject_node_id,
                start=start,
                end=end,
                result_recorded=False,
                delegation=delegation,
                start_order=tool_use.source_order,
                source_stream_id=transcript.source_stream_id,
                request_id=tool_use.request_message_id,
            )[0]
            owner.execution_events.append(start_event)
            for record_index, result in results:
                _, result_event = tool_execution_events(
                    invocation_id=invocation_id,
                    subject_node_id=subject_node_id,
                    start=start,
                    end=Metric.exact(result.end_ms),
                    result_recorded=True,
                    success=not result.is_error,
                    delegation=delegation,
                    start_order=tool_use.source_order,
                    result_order=result.source_order,
                    source_stream_id=transcript.source_stream_id,
                    request_id=tool_use.request_message_id,
                    next_id=result.next_message_id,
                )
                owner.execution_events.append(result_event)
                used_result_records.add(record_index)

        for record_index, (invocation_id, result) in enumerate(record_list):
            if record_index in used_result_records:
                continue
            owner = owner_for(transcript, result.end_ms, None)
            if owner is None:
                continue
            result_event = tool_execution_events(
                invocation_id=invocation_id,
                subject_node_id=None,
                start=Metric.not_available(),
                end=Metric.exact(result.end_ms),
                result_recorded=True,
                success=not result.is_error,
                result_order=result.source_order,
                source_stream_id=transcript.source_stream_id,
                next_id=result.next_message_id,
            )[1]
            owner.execution_events.append(result_event)

    def sort_events(node: Node) -> None:
        node.execution_events.sort(key=lambda event: (event.source_order is None, event.source_order or 0))
        for child in node.children:
            sort_events(child)

    sort_events(root)


def build_root(main: Transcript, subagents: list[Subagent], prices: PriceTable, title: str) -> Node:
    """Build session -> turn -> agent -> tool from the main transcript and all subagent transcripts."""
    builder = _TreeBuilder([main, *(subagent.transcript for subagent in subagents)], prices)
    for subagent in subagents:
        builder.attach(subagent)
    builder.link_resumes()
    main_nodes = builder.take(main) + builder.orphans
    main_calls = builder.calls(main)

    prompts = main.prompts
    synthetic_prompt = False
    if not prompts:
        starts = [start for item in (*main_nodes, *main_calls) if (start := _item_start(item)) is not None]
        if not starts:
            root = Node(node_id="session", kind=NodeKind.SESSION, topic=title)
            transcripts = [main, *(subagent.transcript for subagent in subagents)]
            id_counts: dict[str, int] = {}
            for transcript in transcripts:
                for tool_use in transcript.tool_uses:
                    id_counts[tool_use.tool_use_id] = id_counts.get(tool_use.tool_use_id, 0) + 1
            unique_ids = {invocation_id for invocation_id, count in id_counts.items() if count == 1}
            for transcript in transcripts:
                root.execution_events.extend(
                    ExecutionEvent(
                        kind="compaction", start=Metric.exact(ms), source_stream_id=transcript.source_stream_id
                    )
                    for ms in transcript.compactions_ms
                )
            _emit_tool_events(root, transcripts, builder, unique_ids)
            _attach_native_transcripts(root, main, subagents, [], builder)
            return root
        prompts = [Prompt(uuid=_SYNTHETIC_TURN_ID, start_ms=int(min(starts)), text="")]
        synthetic_prompt = True

    turn_starts = [prompt.start_ms for prompt in prompts]
    node_groups = split_by_turn(main_nodes, _item_start, turn_starts)
    call_groups = split_by_turn(main_calls, _item_start, turn_starts)
    compaction_groups = split_by_turn(main.compactions_ms, _ms_start, turn_starts)
    turns = [
        _turn(prompt, nodes, calls, compactions, main.source_stream_id)
        for prompt, nodes, calls, compactions in zip(prompts, node_groups, call_groups, compaction_groups, strict=True)
    ]
    for prompt, turn in zip(prompts, turns, strict=True):
        if not synthetic_prompt and prompt in main.prompts:
            turn.execution_events.append(
                ExecutionEvent(
                    kind="user_input",
                    event_id=f"user-input:{prompt.uuid}",
                    subject_node_id=turn.node_id,
                    start=Metric.exact(prompt.start_ms),
                    source_order=prompt.source_order,
                    source_stream_id=main.source_stream_id,
                )
            )
    for subagent in subagents:
        owner = builder._transcript_owners.get(id(subagent.transcript))
        if owner is not None:
            for prompt in subagent.transcript.prompts:
                owner.execution_events.append(
                    ExecutionEvent(
                        kind="user_input",
                        event_id=f"user-input:{prompt.uuid}",
                        subject_node_id=owner.node_id,
                        start=Metric.exact(prompt.start_ms),
                        source_order=prompt.source_order,
                        source_stream_id=subagent.transcript.source_stream_id,
                    )
                )

    visible_turns: list[Node] = []
    pending_compactions: list[Metric] = []
    for turn in turns:
        if not turn.llm_calls and not turn.children and not turn.execution_events:
            pending_compactions.extend(turn.compactions)
            continue
        turn.compactions = sorted([*pending_compactions, *turn.compactions], key=Metric.number)
        pending_compactions.clear()
        visible_turns.append(turn)
    if pending_compactions and visible_turns:
        visible_turns[-1].compactions = sorted(
            [*visible_turns[-1].compactions, *pending_compactions], key=Metric.number
        )
    root = Node(node_id="session", kind=NodeKind.SESSION, topic=title, children=visible_turns)
    transcripts = [main, *(subagent.transcript for subagent in subagents)]
    id_counts: dict[str, int] = {}
    for transcript in transcripts:
        for tool_use in transcript.tool_uses:
            id_counts[tool_use.tool_use_id] = id_counts.get(tool_use.tool_use_id, 0) + 1
    unique_ids = {invocation_id for invocation_id, count in id_counts.items() if count == 1}
    _emit_tool_events(root, transcripts, builder, unique_ids)
    _attach_native_transcripts(root, main, subagents, visible_turns, builder)
    return root
