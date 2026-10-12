# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Parse a `GitHub.copilot-chat/debug-logs/<sid>/` directory into LLM calls per agent."""

import json
import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from agentprof.model import TranscriptBlock


@dataclass(frozen=True)
class DebugLlmCall:
    """One `llm_request` span. `input_tokens` includes `cached_tokens`, as Copilot logs it.

    Token counts are `None` when the span does not log them (e.g. a failed or still running request).
    `debug_name` names the request's purpose, e.g. `panel/editAgent` or `summarizeConversationHistory`.
    """

    start_ms: int
    duration_ms: int
    input_tokens: int | None
    output_tokens: int | None
    cached_tokens: int | None
    debug_name: str | None = None
    source_request_id: str | None = None
    requested_tool_ids: tuple[str, ...] = ()
    consumed_tool_ids: tuple[str, ...] = ()
    model: str | None = None
    usage_nano_aiu: int | None = None
    source_filename: str | None = field(default=None, compare=False)
    source_position: int | None = field(default=None, compare=False)
    native_ordinal: int | None = field(default=None, compare=False)


@dataclass(frozen=True)
class DebugMessage:
    """One typed message from a response or one request-history snapshot."""

    role: str | None
    blocks: tuple[TranscriptBlock, ...]
    availability: str = "recorded"
    source_filename: str | None = None
    source_position: int | None = None
    native_ordinal: int | None = None
    native_id: str | None = None
    timestamp_ms: int | None = None


@dataclass(frozen=True)
class DebugResponseRecord:
    """A response record with its physical file and line identity."""

    owner_id: str | None
    request_id: str
    message: DebugMessage


@dataclass(frozen=True)
class DebugHistoryRecord:
    """One request-history snapshot tied to its exact request span."""

    owner_id: str | None
    request_id: str
    messages: tuple[DebugMessage, ...]
    source_filename: str
    source_position: int
    native_ordinal: int
    timestamp_ms: int | None = None


@dataclass
class DebugLog:
    """LLM calls keyed by the owning agent's `toolCallId` (`None` for the main agent)."""

    calls: dict[str | None, list[DebugLlmCall]] = field(default_factory=dict)
    responses: dict[str | None, dict[str, DebugMessage]] = field(default_factory=dict)
    history: dict[str | None, dict[str, tuple[DebugMessage, ...]]] = field(default_factory=dict)
    response_records: list[DebugResponseRecord] = field(default_factory=list)
    history_records: list[DebugHistoryRecord] = field(default_factory=list)
    malformed_lines: int = 0


def _count(attrs: dict[str, Any], key: str) -> int | None:
    value = attrs.get(key)
    return None if value is None else int(value)


def _tool_part_ids(messages: object, part_type: str) -> tuple[str, ...]:
    """Read typed tool IDs, including complete identity headers before Copilot's truncation marker."""
    if isinstance(messages, str):
        encoded = messages
        try:
            messages = json.loads(encoded)
        except json.JSONDecodeError:
            if not encoded.startswith("[") or not encoded.endswith("[truncated]"):
                return ()
            pattern = r'\{"type"\s*:\s*"' + re.escape(part_type) + r'"\s*,\s*"id"\s*:\s*"([^"\\]+)"'
            return tuple(dict.fromkeys(re.findall(pattern, encoded)))
    if not isinstance(messages, list):
        return ()
    ids: list[str] = []
    for message in messages:
        if not isinstance(message, dict) or not isinstance(message.get("parts"), list):
            continue
        for part in message["parts"]:
            if not isinstance(part, dict) or part.get("type") != part_type:
                continue
            tool_id = part.get("id")
            if isinstance(tool_id, str) and tool_id and tool_id not in ids:
                ids.append(tool_id)
    return tuple(ids)


def _message_blocks(message: object) -> DebugMessage:
    if not isinstance(message, dict):
        return DebugMessage(None, (TranscriptBlock(kind="other", data=message, availability="unsupported"),))
    role = message.get("role") if isinstance(message.get("role"), str) else None
    parts = message.get("parts")
    if not isinstance(parts, list):
        return DebugMessage(role, (TranscriptBlock(kind="other", data=message, availability="unsupported"),))
    blocks: list[TranscriptBlock] = []
    for part in parts:
        if not isinstance(part, dict):
            blocks.append(TranscriptBlock(kind="other", data=part, availability="unsupported"))
            continue
        native_type = part.get("type") if isinstance(part.get("type"), str) else None
        text = part.get("text") if isinstance(part.get("text"), str) else None
        if native_type in ("text", "markdown"):
            kind = "message"
        elif native_type in ("reasoning", "reasoning_summary") or "reasoning" in (native_type or ""):
            kind = "reasoning"
        elif native_type in ("tool_call", "tool_call_response"):
            kind = "tool_request" if native_type == "tool_call" else "tool_result"
        else:
            kind = "other"
        encrypted_keys = {"encryptedContent", "encrypted_content", "ciphertext"}
        encrypted = kind == "reasoning" and (
            "encrypted" in (native_type or "").lower()
            or part.get("encrypted") is True
            or any(key in part for key in encrypted_keys)
        )
        availability = (
            "encrypted"
            if encrypted
            else "unavailable"
            if kind == "message" and text is None
            else "recorded"
            if kind != "other"
            else "unsupported"
        )
        data = (
            {key: value for key, value in part.items() if key not in encrypted_keys | {"text", "content"}}
            if encrypted
            else {key: value for key, value in part.items() if key != "text"}
            if text is not None
            else part
        )
        blocks.append(
            TranscriptBlock(
                kind=kind,
                native_type=native_type,
                text=None if encrypted else text,
                data=data,
                availability=availability,
            )
        )
    return DebugMessage(role, tuple(blocks))


def _decode_messages(value: object) -> tuple[list[DebugMessage], str]:
    truncated = isinstance(value, str) and value.endswith("[truncated]")
    if isinstance(value, str):
        encoded = value.removesuffix("[truncated]") if truncated else value
        try:
            value = json.loads(encoded)
        except json.JSONDecodeError:
            if not truncated or not encoded.startswith("["):
                return [], "unsupported"
            decoder = json.JSONDecoder()
            parsed: list[object] = []
            index = 1
            while index < len(encoded):
                while index < len(encoded) and (encoded[index].isspace() or encoded[index] == ","):
                    index += 1
                if index >= len(encoded) or encoded[index] == "]":
                    break
                try:
                    message, index = decoder.raw_decode(encoded, index)
                except json.JSONDecodeError:
                    break
                parsed.append(message)
            value = parsed
    if not isinstance(value, list):
        return [], "unsupported"
    availability = "truncated" if truncated else "recorded"
    return [replace(_message_blocks(message), availability=availability) for message in value], availability


def _parse_call(entry: dict[str, Any], filename: str, source_position: int, native_ordinal: int) -> DebugLlmCall:
    attrs = entry["attrs"]
    debug_name = attrs.get("debugName")
    return DebugLlmCall(
        start_ms=int(entry["ts"]),
        duration_ms=int(entry.get("dur", 0)),
        input_tokens=_count(attrs, "inputTokens"),
        output_tokens=_count(attrs, "outputTokens"),
        cached_tokens=_count(attrs, "cachedTokens"),
        debug_name=debug_name if isinstance(debug_name, str) else None,
        model=attrs.get("model") if isinstance(attrs.get("model"), str) else None,
        usage_nano_aiu=_count(attrs, "copilotUsageNanoAiu"),
        source_filename=filename,
        source_position=source_position,
        native_ordinal=native_ordinal,
        source_request_id=entry.get("spanId") if isinstance(entry.get("spanId"), str) else None,
        consumed_tool_ids=_tool_part_ids(attrs.get("inputMessages"), "tool_call_response"),
    )


def load_debug_log_dir(directory: Path, root_session_id: str) -> DebugLog:
    """Collect `llm_request` spans from every file in a debug-log directory.

    Every line carries a top-level `sid`: the root session id for the main agent's file, otherwise the
    subagent's own `toolCallId`, regardless of nesting depth.

    Args:
        directory: A `<sessionId>/` debug-log directory containing `*.jsonl` files.
        root_session_id: The `sid` used by the main agent's lines.

    Returns:
        The LLM calls per agent and the number of malformed lines skipped.
    """
    log = DebugLog()
    responses: dict[tuple[str | None, str], tuple[str, ...]] = {}
    for file_path in sorted(directory.glob("*.jsonl")):
        ordinal = 0
        for source_position, line in enumerate(file_path.read_text().splitlines()):
            if not line.strip():
                continue
            history_record: DebugHistoryRecord | None = None
            try:
                entry = json.loads(line)
                if entry.get("type") not in ("llm_request", "agent_response"):
                    continue
                sid = entry["sid"]
                key = None if sid == root_session_id else sid
                if entry["type"] == "agent_response":
                    span_id = entry.get("spanId")
                    if isinstance(span_id, str) and span_id.startswith("agent-msg-"):
                        request_id = span_id.removeprefix("agent-msg-")
                        if request_id:
                            response, availability = _decode_messages(entry["attrs"].get("response"))
                            if not response:
                                response = [
                                    DebugMessage(
                                        None,
                                        (
                                            TranscriptBlock(
                                                kind="other",
                                                data=entry["attrs"].get("response"),
                                                availability="unsupported",
                                            ),
                                        ),
                                        availability,
                                    )
                                ]
                            message = DebugMessage(
                                role=response[0].role if response else None,
                                blocks=tuple(block for message in response for block in message.blocks),
                                availability=availability,
                                source_filename=file_path.name,
                                source_position=source_position,
                                native_id=span_id,
                                native_ordinal=ordinal,
                                timestamp_ms=(
                                    int(entry["ts"])
                                    if isinstance(entry.get("ts"), (int, float)) and not isinstance(entry["ts"], bool)
                                    else None
                                ),
                            )
                            log.responses.setdefault(key, {})[request_id] = message
                            log.response_records.append(DebugResponseRecord(key, request_id, message))
                            ordinal += 1
                            ids = _tool_part_ids(entry["attrs"].get("response"), "tool_call")
                            previous = responses.get((key, request_id), ())
                            responses[key, request_id] = tuple(dict.fromkeys((*previous, *ids)))
                    continue
                sid = entry["sid"]
                key = None if sid == root_session_id else sid
                attrs = entry["attrs"]
                request_id = entry.get("spanId")
                if isinstance(request_id, str) and request_id and "inputMessages" in attrs:
                    messages, _ = _decode_messages(attrs.get("inputMessages"))
                    history_record = DebugHistoryRecord(
                        key,
                        request_id,
                        tuple(messages),
                        file_path.name,
                        source_position,
                        ordinal,
                        (
                            int(entry["ts"])
                            if isinstance(entry.get("ts"), (int, float)) and not isinstance(entry["ts"], bool)
                            else None
                        ),
                    )
                call = _parse_call(entry, file_path.name, source_position, ordinal)
            except (json.JSONDecodeError, AttributeError, KeyError, TypeError, ValueError):
                log.malformed_lines += 1
                if history_record is not None:
                    log.history.setdefault(history_record.owner_id, {})[history_record.request_id] = (
                        history_record.messages
                    )
                    log.history_records.append(history_record)
                    ordinal += 1
                continue
            key = None if sid == root_session_id else sid
            log.calls.setdefault(key, []).append(call)
            ordinal += 1
            if history_record is not None:
                history_record = replace(history_record, timestamp_ms=call.start_ms)
                log.history.setdefault(history_record.owner_id, {})[history_record.request_id] = history_record.messages
                log.history_records.append(history_record)
    for owner, calls in log.calls.items():
        log.calls[owner] = [
            replace(call, requested_tool_ids=responses.get((owner, call.source_request_id), ()))
            if call.source_request_id is not None
            else call
            for call in calls
        ]
    return log
