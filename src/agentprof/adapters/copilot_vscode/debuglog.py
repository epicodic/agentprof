# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Parse a `GitHub.copilot-chat/debug-logs/<sid>/` directory into LLM calls per agent."""

import json
import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any


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


@dataclass
class DebugLog:
    """LLM calls keyed by the owning agent's `toolCallId` (`None` for the main agent)."""

    calls: dict[str | None, list[DebugLlmCall]] = field(default_factory=dict)
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


def _parse_call(entry: dict[str, Any]) -> DebugLlmCall:
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
        for line in file_path.read_text().splitlines():
            if not line.strip():
                continue
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
                            ids = _tool_part_ids(entry["attrs"].get("response"), "tool_call")
                            previous = responses.get((key, request_id), ())
                            responses[key, request_id] = tuple(dict.fromkeys((*previous, *ids)))
                    continue
                call = _parse_call(entry)
            except (json.JSONDecodeError, AttributeError, KeyError, TypeError, ValueError):
                log.malformed_lines += 1
                continue
            key = None if sid == root_session_id else sid
            log.calls.setdefault(key, []).append(call)
    for owner, calls in log.calls.items():
        log.calls[owner] = [
            replace(call, requested_tool_ids=responses.get((owner, call.source_request_id), ()))
            if call.source_request_id is not None
            else call
            for call in calls
        ]
    return log
