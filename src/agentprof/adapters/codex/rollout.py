# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Parse native Codex rollout JSONL files."""

from collections.abc import Container
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agentprof.adapters.common import MalformedLines, iter_jsonl
from agentprof.adapters.timestamps import parse_iso_ms
from agentprof.model import MalformedLineDetail, TranscriptBlock, TranscriptKind


@dataclass(frozen=True)
class UsageRecord:
    """Token usage in Agentprof's disjoint token categories."""

    input: int
    cache_read: int
    cache_write: int
    output: int
    recorded_fields: frozenset[str] | None = field(default=None, compare=False)

    def has_field(self, name: str) -> bool:
        """Whether a native count was recorded; constructed records contain all counts."""
        return self.recorded_fields is None or name in self.recorded_fields


@dataclass(frozen=True)
class TokenUsage:
    """One timestamped native token-usage record."""

    usage: UsageRecord
    timestamp_ms: int | None
    response_id: str | None
    source_order: int | None = None


@dataclass(frozen=True)
class UserInput:
    """One native user message with its source identity and position."""

    message_id: str | None
    timestamp_ms: int | None
    source_order: int | None


@dataclass(frozen=True)
class CompactionRecord:
    """A native compaction marker without its encrypted content."""

    event_id: str | None
    timestamp_ms: int | None
    source_order: int


@dataclass
class NativeRecord:
    """One retained response item with both physical and native source positions."""

    source_position: int
    source_order: int
    native_ordinal: int | None
    source_stream_id: str
    logical_stream_id: str | None
    owner_turn_id: str | None
    ownership_evidence: str
    entry_type: str
    native_id: str | None
    timestamp_ms: int | None
    role: str | None
    sender: str | None
    recipient: str | None
    channel: str | None
    kind: TranscriptKind
    blocks: list[TranscriptBlock]
    source_request_id: str | None = None
    response_id: str | None = None
    invocation_id: str | None = None
    event_id: str | None = None


@dataclass(frozen=True)
class ToolResultRecord:
    """One native output record that did not match an earlier invocation."""

    call_id: str | None
    timestamp_ms: int | None
    source_order: int | None
    status: str | None


@dataclass(frozen=True)
class ThreadSpawn:
    """The subagent linkage stored in session metadata when available."""

    parent_thread_id: str | None
    depth: int | None
    agent_path: str | None
    agent_nickname: str | None
    agent_role: str | None


@dataclass
class ToolCall:
    """One native function or custom-tool call and its optional output."""

    call_id: str | None
    name: str
    input: str | None
    start_ms: int | None
    output: str | None = None
    end_ms: int | None = None
    status: str | None = None
    output_status: str | None = None
    start_order: int | None = None
    result_order: int | None = None
    result_recorded: bool = False


@dataclass
class Turn:
    """One native Codex task turn."""

    turn_id: str
    start_ms: int | None = None
    end_ms: int | None = None
    model: str | None = None
    prompt: str | None = None
    tools: list[ToolCall] = field(default_factory=list)
    usage: UsageRecord | None = None
    usages: list[UsageRecord] = field(default_factory=list)
    token_usages: list[TokenUsage] = field(default_factory=list)
    user_inputs: list[UserInput] = field(default_factory=list)
    completion_recorded: bool = False
    completion_order: int | None = None
    unmatched_tool_results: list[ToolResultRecord] = field(default_factory=list)
    compactions: list[CompactionRecord] = field(default_factory=list)
    source_stream_id: str | None = None
    native_source_stream_id: str | None = None
    source_present: bool = False


@dataclass
class Rollout:
    """The native records required for Codex session analysis."""

    session_id: str | None = None
    thread_id: str | None = None
    parent_thread_id: str | None = None
    agent_nickname: str | None = None
    thread_spawn: ThreadSpawn | None = None
    cwd: str | None = None
    model: str | None = None
    result: str | None = None
    turns: list[Turn] = field(default_factory=list)
    malformed_lines: int = 0
    malformed_line_details: list[MalformedLineDetail] = field(default_factory=list)
    last_message_ms: int | None = None
    source_stream_id: str | None = None
    logical_stream_id: str | None = None
    native_records: list[NativeRecord] = field(default_factory=list)
    source_present: bool = False


_USAGE_FIELDS = (
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
)


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _string(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _safe_data(value: object) -> object | None:
    """Retain structured data while stripping encrypted transcript payloads."""
    if isinstance(value, dict):
        encrypted_fields = {"encrypted_content", "ciphertext", "encrypted_payload"}
        return {key: _safe_data(item) for key, item in value.items() if key not in encrypted_fields}
    if isinstance(value, list):
        return [_safe_data(item) for item in value]
    return value


def _content_blocks(value: object, *, kind: str = "text") -> list[TranscriptBlock]:
    if isinstance(value, str):
        return [TranscriptBlock(kind=kind, native_type="text", text=value)]
    if not isinstance(value, list):
        return []
    blocks: list[TranscriptBlock] = []
    text_types = {"input_text", "output_text", "text", "reasoning_text", "summary_text"}
    for raw in value:
        if not isinstance(raw, dict):
            blocks.append(TranscriptBlock(kind="other", availability="unsupported", data=_safe_data(raw)))
            continue
        native_type = _string(raw.get("type"))
        text = _string(raw.get("text"))
        if native_type in text_types and text is not None:
            blocks.append(TranscriptBlock(kind=kind, native_type=native_type, text=text))
        elif native_type in text_types:
            blocks.append(
                TranscriptBlock(kind=kind, native_type=native_type, availability="unavailable", data=_safe_data(raw))
            )
        else:
            blocks.append(
                TranscriptBlock(kind="other", native_type=native_type, availability="unsupported", data=_safe_data(raw))
            )
    return blocks


def _item_content_blocks(payload: dict[str, Any], key: str, *, kind: str = "text") -> list[TranscriptBlock]:
    if key not in payload or payload[key] is None:
        return [TranscriptBlock(kind=kind, native_type=key, availability="unavailable")]
    value = payload[key]
    if isinstance(value, list) and not value:
        return [TranscriptBlock(kind=kind, native_type=key, text="")]
    if isinstance(value, (str, list)):
        return _content_blocks(value, kind=kind)
    return [TranscriptBlock(kind="other", native_type=key, availability="unsupported", data=_safe_data(value))]


def _native_blocks(payload: dict[str, Any]) -> tuple[TranscriptKind, list[TranscriptBlock], str | None]:
    item_type = _string(payload.get("type")) or "other"
    blocks: list[TranscriptBlock] = []
    invocation_id = _string(payload.get("call_id"))
    if item_type == "message":
        role = _string(payload.get("role"))
        kind = "user_message" if role == "user" else "assistant_message" if role == "assistant" else "message"
        return kind, _item_content_blocks(payload, "content"), None
    if item_type == "agent_message":
        blocks = _item_content_blocks(payload, "content")
        metadata = {key: _safe_data(payload[key]) for key in ("author", "recipient") if key in payload}
        if metadata and blocks[0].data is None:
            blocks[0].data = metadata
        return "assistant_message", blocks, None
    if item_type == "reasoning":
        if "content" in payload:
            blocks.extend(_item_content_blocks(payload, "content", kind="reasoning"))
        if "text" in payload:
            blocks.extend(_item_content_blocks(payload, "text", kind="reasoning"))
        if "summary" in payload:
            summary_blocks = _item_content_blocks(payload, "summary", kind="reasoning_summary")
            for block in summary_blocks:
                if block.native_type in {"summary", "text", None}:
                    block.native_type = "summary_text"
            blocks.extend(summary_blocks)
        if "encrypted_content" in payload:
            blocks.append(TranscriptBlock(kind="reasoning", native_type="encrypted_content", availability="encrypted"))
        return "reasoning", blocks or [TranscriptBlock(kind="reasoning", availability="unavailable")], None
    if item_type in ("function_call", "custom_tool_call"):
        arguments = payload.get("arguments") if item_type == "function_call" else payload.get("input")
        blocks = [
            TranscriptBlock(
                kind="tool_request",
                native_type=item_type,
                data={"name": payload.get("name"), "arguments": arguments},
                availability="recorded" if arguments is not None else "unavailable",
            )
        ]
        return "tool_request", blocks, invocation_id
    if item_type in ("function_call_output", "custom_tool_call_output"):
        output = payload.get("output")
        blocks = [
            TranscriptBlock(
                kind="tool_result",
                native_type=item_type,
                text=_string(output),
                data=output if not isinstance(output, str) else None,
                availability="unavailable" if output is None else "recorded",
            )
        ]
        return "tool_result", blocks, invocation_id
    if item_type == "compaction":
        for key in ("content", "summary", "text"):
            if key in payload:
                blocks.extend(_item_content_blocks(payload, key, kind="compaction"))
        if "encrypted_content" in payload:
            blocks.append(TranscriptBlock(kind="compaction", native_type="encrypted_content", availability="encrypted"))
        retained = _safe_data(payload)
        if isinstance(retained, dict):
            metadata = {
                key: value for key, value in retained.items() if key not in {"type", "id", "content", "summary", "text"}
            }
            if metadata:
                blocks.append(TranscriptBlock(kind="compaction", native_type="metadata", data=metadata))
        return "compaction", blocks or [TranscriptBlock(kind="compaction")], None
    return (
        "other",
        [TranscriptBlock(kind="other", native_type=item_type, availability="unsupported", data=_safe_data(payload))],
        None,
    )


def _timestamp(value: object) -> int | None:
    if not isinstance(value, str):
        return None
    try:
        return parse_iso_ms(value)
    except ValueError:
        return None


def _content_text(content: object) -> str | None:
    if isinstance(content, str):
        return content or None
    if not isinstance(content, list):
        return None
    parts = [block["text"] for block in content if isinstance(block, dict) and isinstance(block.get("text"), str)]
    return "\n".join(parts) or None


def _thread_spawn(value: object) -> ThreadSpawn | None:
    if not isinstance(value, dict):
        return None
    depth = value.get("depth")
    return ThreadSpawn(
        parent_thread_id=_text(value.get("parent_thread_id")),
        depth=depth if isinstance(depth, int) and not isinstance(depth, bool) else None,
        agent_path=_text(value.get("agent_path")),
        agent_nickname=_text(value.get("agent_nickname")),
        agent_role=_text(value.get("agent_role")),
    )


def _usage(value: object) -> UsageRecord | None:
    if not isinstance(value, dict) or not any(name in value for name in _USAGE_FIELDS):
        return None

    def count(name: str) -> int:
        item = value.get(name)
        return item if isinstance(item, int) and not isinstance(item, bool) else 0

    cache_read = count("cached_input_tokens")
    cache_write = count("cache_write_input_tokens")
    return UsageRecord(
        input=max(count("input_tokens") - cache_read - cache_write, 0),
        cache_read=cache_read,
        cache_write=cache_write,
        output=count("output_tokens"),
        recorded_fields=frozenset(
            name for name in _USAGE_FIELDS if isinstance(value.get(name), int) and not isinstance(value.get(name), bool)
        ),
    )


def decide_record_owner(
    payload: dict[str, Any], turns: Container[str], active_turn_id: str | None
) -> tuple[str | None, str]:
    """The turn that owns a record and the evidence: its explicit `turn_id`, else the active task."""
    explicit_turn_id = _text(payload.get("turn_id"))
    if explicit_turn_id is not None:
        if explicit_turn_id in turns:
            return explicit_turn_id, f"explicit_turn:{explicit_turn_id}"
        return None, f"unresolved_turn:{explicit_turn_id}"
    if active_turn_id is not None:
        return active_turn_id, f"active_task:{active_turn_id}"
    return None, "unassigned_turn"


class _Parser:
    def __init__(self, source_stream_id: str, *, retain_native: bool = True) -> None:
        self.rollout = Rollout()
        self.rollout.source_stream_id = source_stream_id
        self._turns: dict[str, Turn] = {}
        self._tools: dict[str, ToolCall] = {}
        self._active_turn: Turn | None = None
        self._source_order = 0
        self._retain_native_records = retain_native

    def feed(self, entry: dict[str, Any], physical_position: int) -> None:
        native_ordinal = entry.get("ordinal")
        if not isinstance(native_ordinal, int) or isinstance(native_ordinal, bool):
            native_ordinal = None
        source_order = native_ordinal
        if source_order is None:
            source_order = self._source_order
        self._source_order += 1
        entry_type = entry.get("type")
        payload = entry.get("payload")
        if not isinstance(entry_type, str) or not isinstance(payload, dict):
            return
        if entry_type == "session_meta":
            self._session_meta(payload)
        elif entry_type == "turn_context":
            self._turn_context(payload)
        elif entry_type == "event_msg":
            self._event(payload, _timestamp(entry.get("timestamp")), source_order, native_ordinal, physical_position)
        elif entry_type == "response_item":
            timestamp_ms = _timestamp(entry.get("timestamp"))
            if timestamp_ms is not None and (
                payload.get("type") == "agent_message"
                or (payload.get("type") == "message" and payload.get("role") in ("user", "assistant"))
            ):
                self.rollout.last_message_ms = max(self.rollout.last_message_ms or timestamp_ms, timestamp_ms)
            if self._retain_native_records:
                self._retain_response_item(payload, timestamp_ms, source_order, native_ordinal, physical_position)
            self._response_item(payload, timestamp_ms, source_order)
        elif entry_type == "token_usage_record":
            self._token_usage(payload, _timestamp(entry.get("timestamp")), source_order)

    def _session_meta(self, payload: dict[str, Any]) -> None:
        self.rollout.session_id = _text(payload.get("session_id")) or self.rollout.session_id
        self.rollout.thread_id = _text(payload.get("id")) or self.rollout.thread_id
        self.rollout.parent_thread_id = _text(payload.get("parent_thread_id")) or self.rollout.parent_thread_id
        self.rollout.logical_stream_id = self.rollout.thread_id or self.rollout.session_id
        self.rollout.agent_nickname = _text(payload.get("agent_nickname")) or self.rollout.agent_nickname
        source = payload.get("source")
        subagent = source.get("subagent") if isinstance(source, dict) else None
        spawn = _thread_spawn(subagent.get("thread_spawn")) if isinstance(subagent, dict) else None
        self.rollout.thread_spawn = spawn or self.rollout.thread_spawn
        self.rollout.cwd = _text(payload.get("cwd")) or self.rollout.cwd
        self.rollout.model = _text(payload.get("model")) or self.rollout.model

    def _turn_context(self, payload: dict[str, Any]) -> None:
        turn_id = _text(payload.get("turn_id"))
        if turn_id is not None:
            turn = self._turn(turn_id)
            turn.model = _text(payload.get("model")) or turn.model
            turn.source_stream_id = self.rollout.logical_stream_id or self.rollout.thread_id or self.rollout.session_id
            turn.native_source_stream_id = self.rollout.source_stream_id
            turn.source_present = self.rollout.source_present

    def _event(
        self,
        payload: dict[str, Any],
        timestamp_ms: int | None,
        source_order: int,
        native_ordinal: int | None,
        physical_position: int,
    ) -> None:
        event_type = payload.get("type")
        turn_id = _text(payload.get("turn_id"))
        if self._retain_native_records and event_type in {
            "user_message",
            "agent_message",
            "agent_reasoning",
            "reasoning",
        }:
            content_key = next((key for key in ("content", "message", "text") if key in payload), None)
            if content_key is not None:
                kind = (
                    "user_message"
                    if event_type == "user_message"
                    else ("reasoning" if event_type in {"agent_reasoning", "reasoning"} else "assistant_message")
                )
                blocks = _item_content_blocks(payload, content_key, kind="reasoning" if kind == "reasoning" else "text")
                self._append_native_record(
                    payload,
                    source_order,
                    native_ordinal,
                    physical_position,
                    timestamp_ms,
                    f"event_msg:{event_type}",
                    kind,
                    blocks,
                    None,
                )
        if event_type == "task_started" and turn_id is not None:
            turn = self._turn(turn_id)
            turn.source_stream_id = self.rollout.logical_stream_id or self.rollout.thread_id or self.rollout.session_id
            turn.native_source_stream_id = self.rollout.source_stream_id
            turn.source_present = self.rollout.source_present
            turn.start_ms = _timestamp(payload.get("started_at")) or timestamp_ms or turn.start_ms
            self._active_turn = turn
        elif event_type == "task_complete" and turn_id is not None:
            turn = self._turn(turn_id)
            turn.end_ms = _timestamp(payload.get("completed_at")) or timestamp_ms or turn.end_ms
            turn.completion_recorded = True
            turn.completion_order = source_order
            if self._active_turn is turn:
                self._active_turn = None

    def _response_item(self, payload: dict[str, Any], timestamp_ms: int | None, source_order: int) -> None:
        turn = self._active_turn
        if turn is None:
            return
        item_type = payload.get("type")
        if item_type == "compaction":
            turn.compactions.append(CompactionRecord(_text(payload.get("id")), timestamp_ms, source_order))
            return
        if item_type == "message" and payload.get("role") == "user":
            turn.user_inputs.append(UserInput(_text(payload.get("id")), timestamp_ms, source_order))
            turn.prompt = _content_text(payload.get("content")) or turn.prompt
            return
        if item_type == "agent_message":
            self.rollout.result = _content_text(payload.get("content")) or self.rollout.result
            return
        if item_type in ("function_call", "custom_tool_call"):
            name = _text(payload.get("name"))
            if name is None:
                return
            call_id = _text(payload.get("call_id"))
            raw_input = payload.get("arguments") if item_type == "function_call" else payload.get("input")
            tool = ToolCall(
                call_id,
                name,
                _text(raw_input),
                timestamp_ms,
                status=_text(payload.get("status")),
                start_order=source_order,
            )
            turn.tools.append(tool)
            if call_id is not None:
                self._tools[call_id] = tool
            return
        if item_type in ("function_call_output", "custom_tool_call_output"):
            call_id = _text(payload.get("call_id"))
            tool = self._tools.get(call_id) if call_id is not None else None
            if tool is not None:
                output = payload.get("output")
                tool.output = output if isinstance(output, str) else None
                tool.end_ms = timestamp_ms
                tool.output_status = _text(payload.get("status"))
                tool.result_order = source_order
                tool.result_recorded = True
            else:
                turn.unmatched_tool_results.append(
                    ToolResultRecord(call_id, timestamp_ms, source_order, _text(payload.get("status")))
                )

    def _retain_response_item(
        self,
        payload: dict[str, Any],
        timestamp_ms: int | None,
        source_order: int,
        native_ordinal: int | None,
        physical_position: int,
    ) -> None:
        item_type = _string(payload.get("type")) or "other"
        kind, blocks, invocation_id = _native_blocks(payload)
        self._append_native_record(
            payload,
            source_order,
            native_ordinal,
            physical_position,
            timestamp_ms,
            item_type,
            kind,
            blocks,
            invocation_id,
            _text(payload.get("id")) if item_type == "compaction" else None,
        )

    def _append_native_record(
        self,
        payload: dict[str, Any],
        source_order: int,
        native_ordinal: int | None,
        physical_position: int,
        timestamp_ms: int | None,
        entry_type: str,
        kind: TranscriptKind,
        blocks: list[TranscriptBlock],
        invocation_id: str | None,
        event_id: str | None = None,
    ) -> None:
        source_id = self.rollout.source_stream_id
        if source_id is None:
            return
        owner_turn_id, ownership_evidence = decide_record_owner(
            payload, self._turns, self._active_turn.turn_id if self._active_turn is not None else None
        )
        self.rollout.native_records.append(
            NativeRecord(
                source_position=physical_position,
                source_order=source_order,
                native_ordinal=native_ordinal,
                source_stream_id=source_id,
                logical_stream_id=self.rollout.logical_stream_id or self.rollout.thread_id or self.rollout.session_id,
                owner_turn_id=owner_turn_id,
                ownership_evidence=ownership_evidence,
                entry_type=entry_type,
                native_id=_text(payload.get("id")),
                timestamp_ms=timestamp_ms,
                role=_string(payload.get("role")),
                sender=(
                    (_text(payload.get("author")) or _text(payload.get("sender")))
                    if payload.get("type") == "agent_message"
                    else _text(payload.get("sender"))
                    if payload.get("type") == "message"
                    else None
                ),
                recipient=(
                    _text(payload.get("recipient")) if payload.get("type") in {"agent_message", "message"} else None
                ),
                channel=_string(payload.get("channel")),
                kind=kind,
                blocks=blocks,
                source_request_id=_string(payload.get("response_id")),
                response_id=_string(payload.get("response_id")),
                invocation_id=invocation_id,
                event_id=event_id,
            )
        )

    def _token_usage(self, payload: dict[str, Any], timestamp_ms: int | None, source_order: int) -> None:
        usage = _usage(payload.get("usage"))
        if usage is None:
            return
        turn_id = _text(payload.get("turn_id"))
        turn = self._turns.get(turn_id) if turn_id is not None else self._active_turn
        if turn is not None:
            turn.usage = usage
            turn.usages.append(usage)
            turn.token_usages.append(TokenUsage(usage, timestamp_ms, _text(payload.get("response_id")), source_order))

    def _turn(self, turn_id: str) -> Turn:
        turn = self._turns.get(turn_id)
        if turn is None:
            turn = Turn(turn_id=turn_id, model=self.rollout.model)
            self._turns[turn_id] = turn
            self.rollout.turns.append(turn)
        return turn


def _source_stream_id(path: Path, source_root: Path | None = None) -> str:
    """Return a relocation-stable physical source identity relative to its discovery root."""
    if source_root is not None:
        try:
            relative = path.relative_to(source_root).parts
        except ValueError:
            # A directly opened file outside the configured tree is its own source context.
            relative = (path.name,)
    else:
        parts = path.parts
        sessions_indexes = [index for index, part in enumerate(parts) if part == "sessions"]
        relative = parts[sessions_indexes[-1] :] if sessions_indexes else (path.name,)
    return "codex-source:" + "/".join(relative)


def load_rollout(path: Path, source_root: Path | None = None, *, retain_native: bool = True) -> Rollout:
    """Load one rollout JSONL file, skipping and counting malformed lines.

    `retain_native=False` skips `native_records`, the transcript entries only `analyze` needs.
    """
    parser = _Parser(_source_stream_id(path, source_root), retain_native=retain_native)
    malformed = MalformedLines()
    parser.rollout.source_present = True  # turns copy it while parsing; reset below if the file is unreadable
    try:
        for line in iter_jsonl(path, malformed):
            try:
                parser.feed(line.value, line.number - 1)
            except (TypeError, ValueError) as error:
                malformed.add(path, line.number, line.text, error)
    except OSError:
        parser.rollout.source_present = False
        return parser.rollout
    parser.rollout.malformed_lines = malformed.count
    parser.rollout.malformed_line_details = malformed.details
    return parser.rollout
