# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Parse one Claude Code transcript file: the main session or one subagent."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agentprof.adapters.common import MalformedLines, iter_jsonl
from agentprof.adapters.timestamps import parse_iso_ms
from agentprof.model import MalformedLineDetail, TranscriptBlock, TranscriptKind


@dataclass
class Prompt:
    """A user prompt: typed text, a slash command or a task notification."""

    uuid: str
    start_ms: int
    text: str
    source_order: int | None = None
    source_position: int | None = None


@dataclass
class AssistantMessage:
    """One LLM call; Claude Code writes one line per content block, all sharing `message_id`."""

    message_id: str
    start_ms: int
    model: str | None
    usage: dict[str, Any] = field(default_factory=dict)
    source_order: int | None = None


@dataclass
class ToolUse:
    """A `tool_use` block of an assistant message."""

    tool_use_id: str
    name: str
    input: dict[str, object]
    start_ms: int
    source_order: int | None = None
    request_message_id: str | None = None


@dataclass
class ToolResult:
    """The `tool_result` answering a `ToolUse` with the same id."""

    end_ms: int
    is_error: bool
    text: str
    source_order: int | None = None
    next_message_id: str | None = None


@dataclass
class NativeRecord:
    """One native JSONL record retained independently of legacy accounting rows."""

    source_position: int
    source_order: int
    entry_type: str
    native_id: str | None
    timestamp_ms: int | None
    role: str | None
    channel: str | None
    kind: TranscriptKind
    blocks: list[TranscriptBlock]
    source_request_id: str | None = None
    invocation_id: str | None = None
    stop_reason: str | None = None


@dataclass
class Transcript:
    """Everything agentprof needs from one transcript file, in file order.

    `compactions_ms` are the timestamps of `compact_boundary` entries.
    """

    prompts: list[Prompt] = field(default_factory=list)
    messages: list[AssistantMessage] = field(default_factory=list)
    tool_uses: list[ToolUse] = field(default_factory=list)
    tool_results: dict[str, ToolResult] = field(default_factory=dict)
    tool_result_records: list[tuple[str, ToolResult]] = field(default_factory=list)
    source_stream_id: str | None = None
    native_source_stream_id: str | None = None
    native_records: list[NativeRecord] = field(default_factory=list)
    compactions_ms: list[int] = field(default_factory=list)
    title: str | None = None
    cwd: str | None = None
    first_timestamp_ms: int | None = None
    last_message_ms: int | None = None
    malformed_lines: int = 0
    malformed_line_details: list[MalformedLineDetail] = field(default_factory=list)


def _text_of(content: object) -> str:
    """Plain text of a message or tool result `content`: a string or a list of blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block["text"] for block in content if isinstance(block, dict) and isinstance(block.get("text"), str)
        )
    return ""


def _string_value(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _blocks(content: object) -> list[dict[str, Any]]:
    return [block for block in content if isinstance(block, dict)] if isinstance(content, list) else []


class _Parser:
    def __init__(
        self,
        source_stream_id: str | None = None,
        native_source_stream_id: str | None = None,
        *,
        retain_native: bool = True,
    ) -> None:
        self.transcript = Transcript()
        self.transcript.source_stream_id = source_stream_id
        self.transcript.native_source_stream_id = native_source_stream_id
        self._messages: dict[str, AssistantMessage] = {}
        self._seen_tool_uses: set[str] = set()
        self._pending_next_calls: list[ToolResult] = []
        self._source_order = 0
        self._retain_native_records = retain_native

    def feed(self, entry: dict[str, Any], physical_position: int | None = None) -> None:
        source_order = self._source_order
        self._source_order += 1
        if physical_position is not None and self._retain_native_records:
            self._retain_native(entry, physical_position, source_order)
        entry_type = entry.get("type")
        if entry_type == "ai-title":
            title = entry.get("aiTitle")
            if isinstance(title, str) and title:
                self.transcript.title = title
            return
        if entry_type == "system" and entry.get("subtype") == "compact_boundary":
            self.transcript.compactions_ms.append(parse_iso_ms(entry["timestamp"]))
            return
        if entry_type not in ("user", "assistant"):
            return
        timestamp_ms = parse_iso_ms(entry["timestamp"])
        message = entry["message"]
        if entry_type == "assistant":
            self._feed_assistant(entry, message, timestamp_ms, source_order)
            self.transcript.last_message_ms = max(self.transcript.last_message_ms or timestamp_ms, timestamp_ms)
        else:
            prompt_count = len(self.transcript.prompts)
            self._feed_user(entry, message, timestamp_ms, source_order, physical_position)
            if len(self.transcript.prompts) > prompt_count:
                self.transcript.last_message_ms = max(self.transcript.last_message_ms or timestamp_ms, timestamp_ms)
        if self.transcript.first_timestamp_ms is None:
            self.transcript.first_timestamp_ms = timestamp_ms
        if self.transcript.cwd is None and isinstance(entry.get("cwd"), str):
            self.transcript.cwd = entry["cwd"]

    def _feed_assistant(
        self, entry: dict[str, Any], message: dict[str, Any], timestamp_ms: int, source_order: int
    ) -> None:
        message_id = str(message.get("id") or entry["uuid"])
        call = self._messages.get(message_id)
        if call is None:
            for result in self._pending_next_calls:
                result.next_message_id = message_id
            self._pending_next_calls.clear()
            model = message.get("model")
            call = AssistantMessage(
                message_id=message_id,
                start_ms=timestamp_ms,
                model=model if isinstance(model, str) else None,
                source_order=source_order,
            )
            self._messages[message_id] = call
            self.transcript.messages.append(call)
        usage = message.get("usage")
        if isinstance(usage, dict):
            call.usage = usage  # every line repeats the usage; the last line carries the final counts
        for block in _blocks(message.get("content")):
            if block.get("type") != "tool_use" or block["id"] in self._seen_tool_uses:
                continue
            self._seen_tool_uses.add(block["id"])
            tool_input = block.get("input")
            self.transcript.tool_uses.append(
                ToolUse(
                    tool_use_id=str(block["id"]),
                    name=str(block["name"]),
                    input=tool_input if isinstance(tool_input, dict) else {},
                    start_ms=timestamp_ms,
                    source_order=source_order,
                    request_message_id=message_id,
                )
            )

    def _feed_user(
        self,
        entry: dict[str, Any],
        message: dict[str, Any],
        timestamp_ms: int,
        source_order: int,
        physical_position: int | None = None,
    ) -> None:
        content = message.get("content")
        results = [block for block in _blocks(content) if block.get("type") == "tool_result"]
        for block in results:
            invocation_id = str(block["tool_use_id"])
            result = ToolResult(
                end_ms=timestamp_ms,
                is_error=bool(block.get("is_error")),
                text=_text_of(block.get("content")),
                source_order=source_order,
            )
            self.transcript.tool_results[invocation_id] = result
            self.transcript.tool_result_records.append((invocation_id, result))
            self._pending_next_calls.append(result)
        if results or entry.get("isMeta"):
            return
        self.transcript.prompts.append(
            Prompt(
                uuid=str(entry["uuid"]),
                start_ms=timestamp_ms,
                text=_text_of(content),
                source_order=source_order,
                source_position=physical_position,
            )
        )

    def _retain_native(self, entry: dict[str, Any], physical_position: int, source_order: int) -> None:
        entry_type = entry.get("type")
        message = entry.get("message")
        subtype = entry.get("subtype")
        if entry_type not in ("user", "assistant") and not (entry_type == "system" and subtype == "compact_boundary"):
            return
        if not isinstance(message, dict):
            message = {}
        raw_timestamp = entry.get("timestamp")
        try:
            timestamp_ms = parse_iso_ms(raw_timestamp) if isinstance(raw_timestamp, str) else None
        except (TypeError, ValueError):
            timestamp_ms = None
        native_id_value = message.get("id") if entry_type == "assistant" else entry.get("uuid")
        native_id = str(native_id_value) if native_id_value is not None else None
        content_present = "content" in message if entry_type in ("user", "assistant") else "content" in entry
        content = message.get("content") if entry_type in ("user", "assistant") else entry.get("content")
        raw_blocks = content if isinstance(content, list) else None
        blocks: list[TranscriptBlock] = []
        invocation_id: str | None = None
        if entry_type == "system":
            kind = "compaction"
            if isinstance(content, str):
                blocks = [TranscriptBlock(kind="text", native_type="text", text=content)]
        elif not content_present:
            kind = "assistant_message" if entry_type == "assistant" else "user_message"
            blocks = [TranscriptBlock(kind="message", availability="unavailable")]
        elif isinstance(content, str):
            kind = "assistant_message" if entry_type == "assistant" else "user_message"
            blocks = [TranscriptBlock(kind="text", native_type="text", text=content)]
        elif raw_blocks is not None:
            default_kind = "assistant_message" if entry_type == "assistant" else "user_message"
            kind = default_kind
            for raw_block in raw_blocks:
                if not isinstance(raw_block, dict):
                    blocks.append(TranscriptBlock(kind="other", availability="unsupported", data=raw_block))
                    continue
                block_type_value = raw_block.get("type")
                block_type = block_type_value if isinstance(block_type_value, str) else None
                if entry_type == "assistant" and block_type == "thinking":
                    thinking = raw_block.get("thinking")
                    blocks.append(
                        TranscriptBlock(
                            kind="reasoning",
                            native_type=block_type,
                            text=_string_value(thinking),
                            availability="recorded" if isinstance(thinking, str) else "unavailable",
                        )
                    )
                elif entry_type == "assistant" and block_type in ("summary", "reasoning_summary"):
                    summary = raw_block.get("summary", raw_block.get("text"))
                    blocks.append(
                        TranscriptBlock(
                            kind="reasoning_summary",
                            native_type=block_type,
                            text=_string_value(summary),
                            availability="recorded" if isinstance(summary, str) else "unavailable",
                        )
                    )
                elif entry_type == "assistant" and block_type == "redacted_thinking":
                    blocks.append(TranscriptBlock(kind="reasoning", native_type=block_type, availability="encrypted"))
                elif block_type == "text":
                    text = raw_block.get("text")
                    blocks.append(
                        TranscriptBlock(
                            kind="text",
                            native_type=block_type,
                            text=_string_value(text),
                            availability="recorded" if isinstance(text, str) else "unavailable",
                        )
                    )
                elif entry_type == "assistant" and block_type == "tool_use":
                    invocation_id = str(raw_block.get("id")) if raw_block.get("id") is not None else None
                    blocks.append(
                        TranscriptBlock(
                            kind="tool_request",
                            native_type=block_type,
                            data=raw_block,
                        )
                    )
                elif entry_type == "user" and block_type == "tool_result":
                    invocation_id = (
                        str(raw_block.get("tool_use_id")) if raw_block.get("tool_use_id") is not None else None
                    )
                    result_content = raw_block.get("content")
                    result_text = (
                        result_content
                        if isinstance(result_content, str)
                        else (
                            _text_of(result_content)
                            if isinstance(result_content, list)
                            and (
                                not result_content
                                or any(
                                    isinstance(item, dict) and isinstance(item.get("text"), str)
                                    for item in result_content
                                )
                            )
                            else None
                        )
                    )
                    result_availability = (
                        "recorded"
                        if isinstance(result_content, (str, list))
                        else "unavailable"
                        if "content" not in raw_block or result_content is None
                        else "unsupported"
                    )
                    blocks.append(
                        TranscriptBlock(
                            kind="tool_result",
                            native_type=block_type,
                            text=result_text,
                            data=raw_block,
                            availability=result_availability,
                        )
                    )
                else:
                    blocks.append(
                        TranscriptBlock(
                            kind="other", native_type=block_type, availability="unsupported", data=raw_block
                        )
                    )
        else:
            kind = "assistant_message" if entry_type == "assistant" else "user_message"
            blocks = [TranscriptBlock(kind="message", availability="unsupported", data=content)]
        if entry_type == "user" and any(block.kind == "tool_result" for block in blocks):
            kind = "tool_result"
        if entry.get("isMeta") is True:
            for block in blocks:
                if block.kind == "text" and block.data is None:
                    block.data = {"isMeta": True}
        role_value = message.get("role")
        role = role_value if isinstance(role_value, str) else ("system" if entry_type == "system" else entry_type)
        channel_value = entry.get("channel", message.get("channel"))
        channel = channel_value if isinstance(channel_value, str) else None
        message_id = message.get("id")
        self.transcript.native_records.append(
            NativeRecord(
                source_position=physical_position,
                source_order=source_order,
                entry_type=str(entry_type),
                native_id=native_id,
                timestamp_ms=timestamp_ms,
                role=role,
                channel=channel,
                kind=kind,
                blocks=blocks,
                source_request_id=str(message_id) if entry_type == "assistant" and message_id is not None else None,
                invocation_id=invocation_id,
                stop_reason=_string_value(message.get("stop_reason")),
            )
        )


def load_transcript(path: Path, *, retain_native: bool = True) -> Transcript:
    """Parse one transcript file; malformed lines are skipped and counted.

    `retain_native=False` skips `native_records`, the transcript entries only `analyze` needs.
    """
    logical_stream_id = f"claude-code:{path.stem}"
    source_parts = path.parts[-4:] if path.parent.name == "subagents" else path.parts[-2:]
    relative_source = "/".join(source_parts)
    parser = _Parser(
        source_stream_id=logical_stream_id,
        native_source_stream_id=f"claude-code-source:{relative_source}",
        retain_native=retain_native,
    )
    malformed = MalformedLines()
    for line in iter_jsonl(path, malformed):
        try:
            parser.feed(line.value, line.number)
        except (AttributeError, KeyError, TypeError, ValueError) as error:
            malformed.add(path, line.number, line.text, error)
    parser.transcript.malformed_lines = malformed.count
    parser.transcript.malformed_line_details = malformed.details
    return parser.transcript
