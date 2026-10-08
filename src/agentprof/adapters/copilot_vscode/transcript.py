# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Parse `GitHub.copilot-chat/transcripts/<sid>.jsonl`: tool timings and LLM call attribution."""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agentprof.adapters.copilot_vscode.tools import is_subagent_tool_id
from agentprof.adapters.timestamps import parse_iso_ms


@dataclass
class ToolTiming:
    """Start/end time (epoch ms) and outcome of one tool call."""

    start_ms: int | None = None
    end_ms: int | None = None
    success: bool | None = None
    start_order: int | None = None
    completion_order: int | None = None
    completion_recorded: bool = False


@dataclass(frozen=True)
class UserMessage:
    """One source-recorded Copilot user message."""

    message_id: str | None
    timestamp_ms: int
    source_order: int


@dataclass(frozen=True)
class ToolEventRecord:
    """One native tool start or completion snapshot, including records without an invocation ID."""

    kind: str
    tool_call_id: str | None
    timestamp_ms: int
    source_order: int
    owner_id: str | None
    tool_name: str | None = None
    success: bool | None = None


@dataclass
class Transcript:
    """Per-`toolCallId` timing and arguments, and per-agent LLM call timestamps (key `None` is the main agent).

    The arguments cover subagents' tool calls too, which the session file records without them.
    """

    tool_timings: dict[str, ToolTiming] = field(default_factory=dict)
    tool_arguments: dict[str, dict[str, object]] = field(default_factory=dict)
    llm_call_timestamps_ms: dict[str | None, list[int]] = field(default_factory=dict)
    llm_call_source_orders: dict[str | None, list[int]] = field(default_factory=dict)
    llm_call_source_request_ids: dict[str | None, list[str | None]] = field(default_factory=dict)
    tool_request_ids: dict[str, str] = field(default_factory=dict)
    user_messages: list[UserMessage] = field(default_factory=list)
    tool_events: list[ToolEventRecord] = field(default_factory=list)
    session_id: str | None = None
    malformed_lines: int = 0


def _apply_event(transcript: Transcript, stack: list[str | None], event: dict[str, Any], source_order: int) -> None:
    timestamp_ms = parse_iso_ms(event["timestamp"])
    event_type = event["type"]

    if event_type == "assistant.message":
        transcript.llm_call_timestamps_ms.setdefault(stack[-1], []).append(timestamp_ms)
        transcript.llm_call_source_orders.setdefault(stack[-1], []).append(source_order)
        data = event["data"]
        message_id = data.get("messageId") if isinstance(data, dict) else None
        transcript.llm_call_source_request_ids.setdefault(stack[-1], []).append(
            message_id if isinstance(message_id, str) else None
        )
        tool_requests = data.get("toolRequests", []) if isinstance(data, dict) else []
        if isinstance(tool_requests, list) and isinstance(message_id, str):
            for request in tool_requests:
                if isinstance(request, dict):
                    tool_call_id = request.get("toolCallId")
                    if isinstance(tool_call_id, str) and tool_call_id:
                        transcript.tool_request_ids[tool_call_id] = message_id

    elif event_type == "user.message":
        transcript.user_messages.append(
            UserMessage(
                event.get("id") if isinstance(event.get("id"), str) else None,
                timestamp_ms,
                source_order,
            )
        )
        if transcript.session_id is None:
            session_id = event.get("sessionId")
            if isinstance(session_id, str):
                transcript.session_id = session_id

    elif event_type == "session.start":
        data = event.get("data")
        session_id = data.get("sessionId") if isinstance(data, dict) else None
        if isinstance(session_id, str):
            transcript.session_id = session_id

    elif event_type == "tool.execution_start":
        data = event["data"]
        tool_call_id = data.get("toolCallId")
        transcript.tool_events.append(
            ToolEventRecord(
                kind=event_type,
                tool_call_id=tool_call_id if isinstance(tool_call_id, str) and tool_call_id else None,
                timestamp_ms=timestamp_ms,
                source_order=source_order,
                owner_id=stack[-1],
                tool_name=data.get("toolName") if isinstance(data.get("toolName"), str) else None,
            )
        )
        if not isinstance(tool_call_id, str) or not tool_call_id:
            return
        timing = transcript.tool_timings.setdefault(tool_call_id, ToolTiming())
        timing.start_ms = timestamp_ms
        timing.start_order = source_order
        arguments = data.get("arguments")
        if isinstance(arguments, dict):
            transcript.tool_arguments[tool_call_id] = arguments
        if is_subagent_tool_id(data["toolName"]):
            stack.append(tool_call_id)

    elif event_type == "tool.execution_complete":
        data = event["data"]
        tool_call_id = data.get("toolCallId")
        success = data.get("success")
        transcript.tool_events.append(
            ToolEventRecord(
                kind=event_type,
                tool_call_id=tool_call_id if isinstance(tool_call_id, str) and tool_call_id else None,
                timestamp_ms=timestamp_ms,
                source_order=source_order,
                owner_id=stack[-1],
                success=success if isinstance(success, bool) else None,
            )
        )
        if not isinstance(tool_call_id, str) or not tool_call_id:
            return
        timing = transcript.tool_timings.setdefault(tool_call_id, ToolTiming())
        timing.end_ms = timestamp_ms
        timing.success = data.get("success")
        timing.completion_order = source_order
        timing.completion_recorded = True
        if stack[-1] == tool_call_id:
            stack.pop()


def load_transcript(path: Path) -> Transcript:
    """Parse a transcript file.

    Args:
        path: Path to the transcript file.

    Returns:
        Tool timings and LLM calls attributed to the agent whose subagent bracket was open at the time.
    """
    transcript = Transcript()
    # The stack tracks which agent tool call's bracket is currently open; `None` is the main agent.
    stack: list[str | None] = [None]

    for source_order, line in enumerate(path.read_text().splitlines()):
        if not line.strip():
            continue
        try:
            _apply_event(transcript, stack, json.loads(line), source_order)
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            transcript.malformed_lines += 1

    return transcript
