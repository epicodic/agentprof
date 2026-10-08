# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Parse native Codex rollout JSONL files."""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agentprof.adapters.timestamps import parse_iso_ms


@dataclass(frozen=True)
class UsageRecord:
    """Token usage in Agentprof's disjoint token categories."""

    input: int
    cache_read: int
    cache_write: int
    output: int


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
    last_message_ms: int | None = None


_USAGE_FIELDS = (
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
)


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


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
    )


class _Parser:
    def __init__(self) -> None:
        self.rollout = Rollout()
        self._turns: dict[str, Turn] = {}
        self._tools: dict[str, ToolCall] = {}
        self._active_turn: Turn | None = None
        self._source_order = 0

    def feed(self, entry: dict[str, Any]) -> None:
        source_order = entry.get("ordinal")
        if not isinstance(source_order, int) or isinstance(source_order, bool):
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
            self._event(payload, _timestamp(entry.get("timestamp")), source_order)
        elif entry_type == "response_item":
            timestamp_ms = _timestamp(entry.get("timestamp"))
            if timestamp_ms is not None and (
                payload.get("type") == "agent_message"
                or (payload.get("type") == "message" and payload.get("role") in ("user", "assistant"))
            ):
                self.rollout.last_message_ms = max(self.rollout.last_message_ms or timestamp_ms, timestamp_ms)
            self._response_item(payload, timestamp_ms, source_order)
        elif entry_type == "token_usage_record":
            self._token_usage(payload, _timestamp(entry.get("timestamp")), source_order)

    def _session_meta(self, payload: dict[str, Any]) -> None:
        self.rollout.session_id = _text(payload.get("session_id")) or self.rollout.session_id
        self.rollout.thread_id = _text(payload.get("id")) or self.rollout.thread_id
        self.rollout.parent_thread_id = _text(payload.get("parent_thread_id")) or self.rollout.parent_thread_id
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

    def _event(self, payload: dict[str, Any], timestamp_ms: int | None, source_order: int) -> None:
        event_type = payload.get("type")
        turn_id = _text(payload.get("turn_id"))
        if event_type == "task_started" and turn_id is not None:
            turn = self._turn(turn_id)
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


def load_rollout(path: Path) -> Rollout:
    """Load one rollout JSONL file, skipping and counting malformed lines."""
    parser = _Parser()
    try:
        lines = path.open("rb")
    except OSError:
        return parser.rollout
    with lines:
        for raw_line in lines:
            if not raw_line.strip():
                continue
            try:
                entry = json.loads(raw_line.decode("utf-8"))
                if not isinstance(entry, dict):
                    raise TypeError("rollout line is not a JSON object")
                parser.feed(entry)
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                parser.rollout.malformed_lines += 1
    return parser.rollout
