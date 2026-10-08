# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Parse one Claude Code transcript file: the main session or one subagent."""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agentprof.adapters.timestamps import parse_iso_ms
from agentprof.model import MalformedLineDetail

_MAX_MALFORMED_LINE_DETAILS = 20
_MAX_EXCERPT_LENGTH = 120


@dataclass
class Prompt:
    """A user prompt: typed text, a slash command or a task notification."""

    uuid: str
    start_ms: int
    text: str
    source_order: int | None = None


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
    compactions_ms: list[int] = field(default_factory=list)
    title: str | None = None
    cwd: str | None = None
    first_timestamp_ms: int | None = None
    last_message_ms: int | None = None
    malformed_lines: int = 0
    malformed_line_details: list[MalformedLineDetail] = field(default_factory=list)


def _redacted_excerpt(line: str) -> str:
    """Retain short JSON syntax shape while removing all string and scalar contents."""
    parts: list[str] = []
    in_string = False
    escaped = False
    redacting_scalar = False
    for char in line[:_MAX_EXCERPT_LENGTH]:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                parts.append('"')
                in_string = False
            continue
        if char == '"':
            parts.append('"[redacted]')
            in_string = True
            redacting_scalar = False
        elif char in "{}[]:,":
            parts.append(char)
            redacting_scalar = False
        elif char.isspace():
            parts.append(" ")
            redacting_scalar = False
        elif not redacting_scalar:
            parts.append("[redacted]")
            redacting_scalar = True
    excerpt = "".join(parts)
    if len(line) > _MAX_EXCERPT_LENGTH:
        return excerpt[: _MAX_EXCERPT_LENGTH - 1] + "…"
    return excerpt[:_MAX_EXCERPT_LENGTH]


def _error_category(error: json.JSONDecodeError | AttributeError | KeyError | TypeError | ValueError) -> str:
    if isinstance(error, json.JSONDecodeError):
        return "invalid_json"
    if isinstance(error, KeyError):
        return "missing_field"
    if isinstance(error, TypeError) and str(error) == "transcript line is not a JSON object":
        return "non_object"
    if isinstance(error, (TypeError, AttributeError)):
        return "invalid_type"
    return "invalid_value"


def _text_of(content: object) -> str:
    """Plain text of a message or tool result `content`: a string or a list of blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block["text"] for block in content if isinstance(block, dict) and isinstance(block.get("text"), str)
        )
    return ""


def _blocks(content: object) -> list[dict[str, Any]]:
    return [block for block in content if isinstance(block, dict)] if isinstance(content, list) else []


class _Parser:
    def __init__(self, source_stream_id: str | None = None) -> None:
        self.transcript = Transcript()
        self.transcript.source_stream_id = source_stream_id
        self._messages: dict[str, AssistantMessage] = {}
        self._seen_tool_uses: set[str] = set()
        self._pending_next_calls: list[ToolResult] = []
        self._source_order = 0

    def feed(self, entry: dict[str, Any]) -> None:
        source_order = self._source_order
        self._source_order += 1
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
            self._feed_user(entry, message, timestamp_ms, source_order)
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

    def _feed_user(self, entry: dict[str, Any], message: dict[str, Any], timestamp_ms: int, source_order: int) -> None:
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
            Prompt(uuid=str(entry["uuid"]), start_ms=timestamp_ms, text=_text_of(content), source_order=source_order)
        )


def load_transcript(path: Path) -> Transcript:
    """Parse one transcript file; malformed lines are skipped and counted."""
    parser = _Parser(source_stream_id=f"claude-code:{path.stem}")
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                if not isinstance(entry, dict):
                    raise TypeError("transcript line is not a JSON object")
                parser.feed(entry)
            except (json.JSONDecodeError, AttributeError, KeyError, TypeError, ValueError) as error:
                parser.transcript.malformed_lines += 1
                if len(parser.transcript.malformed_line_details) < _MAX_MALFORMED_LINE_DETAILS:
                    parser.transcript.malformed_line_details.append(
                        MalformedLineDetail(
                            source_path=str(path),
                            line_number=line_number,
                            excerpt=_redacted_excerpt(line.rstrip("\r\n")),
                            error_category=_error_category(error),
                        )
                    )
    return parser.transcript
