# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Parse a Copilot Chat export (`.json`) or live session (`chatSessions/<sid>.jsonl`)."""

import json
import re
import string
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from agentprof.adapters.copilot_vscode.tools import is_subagent_tool_id

_VSCODE_ID_SUFFIX = re.compile(r"__vscode-\d+$")
_MARKDOWN_LINK = re.compile(r"\[([^\]]*)\]\(([^)]*)\)")
_BACKSLASH_ESCAPE = re.compile(f"\\\\([{re.escape(string.punctuation)}])")
_FILE_SCHEME = "file://"


@dataclass
class RawToolCall:
    """One `toolInvocationSerialized` response part."""

    tool_call_id: str
    tool_id: str
    topic: str
    parent_tool_call_id: str | None
    is_agent: bool = False
    subagent_description: str | None = None
    subagent_prompt: str | None = None
    subagent_model: str | None = None
    subagent_result: str | None = None
    subagent_credits: float | None = None
    arguments: dict[str, object] = field(default_factory=dict)


@dataclass
class RawRequest:
    """One user turn, with its tool calls in response order."""

    request_id: str
    text: str
    timestamp_ms: int
    model_id: str | None
    session_id: str | None
    credits: float | None
    prompt_tokens: int | None
    completion_tokens: int | None
    time_spent_waiting_ms: int | None
    elapsed_ms: int | None
    response_timestamp_ms: int | None = None
    round_timestamps_ms: list[int] = field(default_factory=list)
    tool_calls: list[RawToolCall] = field(default_factory=list)


@dataclass
class RawSession:
    """A parsed export or replayed live session."""

    session_id: str | None
    title: str
    creation_ms: int | None
    requests: list[RawRequest]
    malformed_lines: int = 0


def _markdown_link_replacement(match: re.Match[str]) -> str:
    label, target = match.group(1), match.group(2)
    if label:
        return label
    if target.startswith(_FILE_SCHEME):
        path = target[len(_FILE_SCHEME) :].split("#", 1)[0]
        return unquote(path)
    return target


def clean_topic(text: str) -> str:
    """Render Copilot's Markdown `invocationMessage` down to a plain topic string."""
    text = _MARKDOWN_LINK.sub(_markdown_link_replacement, text)
    return _BACKSLASH_ESCAPE.sub(r"\1", text)


def _topic_of(part: dict[str, Any]) -> str:
    message = part.get("invocationMessage")
    if isinstance(message, dict):
        return clean_topic(str(message.get("value", "")))
    return clean_topic(str(message or ""))


def _parse_tool_call(part: dict[str, Any], round_arguments: dict[str, dict[str, object]]) -> RawToolCall:
    tool_specific = part.get("toolSpecificData") or {}
    return RawToolCall(
        tool_call_id=part["toolCallId"],
        tool_id=part["toolId"],
        topic=_topic_of(part),
        parent_tool_call_id=part.get("subAgentInvocationId"),
        subagent_description=tool_specific.get("description"),
        subagent_prompt=tool_specific.get("prompt"),
        subagent_model=tool_specific.get("modelName"),
        subagent_result=tool_specific.get("result"),
        subagent_credits=tool_specific.get("credits"),
        arguments=round_arguments.get(part["toolCallId"], {}),
    )


def _deduplicate_tool_calls(tool_calls: Iterable[RawToolCall]) -> list[RawToolCall]:
    """Copilot re-serializes live-updating tool calls; keep the first occurrence's position but the last's data."""
    by_id: dict[str, RawToolCall] = {}
    for tool_call in tool_calls:
        by_id[tool_call.tool_call_id] = tool_call
    return list(by_id.values())


def _parse_round_arguments(rounds: list[dict[str, Any]]) -> dict[str, dict[str, object]]:
    """Map each round-dispatched tool call's id to its parsed arguments (a JSON string in the raw data).

    Live sessions suffix the round id with `__vscode-<digits>` (e.g. `toolu_...__vscode-1779116386890`) while
    the response part's `toolCallId` carries the bare id; that suffix is stripped so the two line up.
    """
    arguments_by_id: dict[str, dict[str, object]] = {}
    for round_ in rounds:
        for tool_call in round_.get("toolCalls", []):
            raw_arguments = tool_call.get("arguments")
            if not raw_arguments:
                continue
            try:
                parsed = json.loads(raw_arguments)
            except json.JSONDecodeError:
                continue
            arguments_by_id[_VSCODE_ID_SUFFIX.sub("", tool_call["id"])] = parsed
    return arguments_by_id


def _parse_request(raw: dict[str, Any]) -> RawRequest:
    metadata = raw.get("result", {}).get("metadata", {})
    rounds = metadata.get("toolCallRounds", [])
    round_arguments = _parse_round_arguments(rounds)

    tool_calls = _deduplicate_tool_calls(
        _parse_tool_call(part, round_arguments)
        for part in raw.get("response", [])
        if part.get("kind") == "toolInvocationSerialized" and "toolCallId" in part
    )

    # A tool call is an agent if its id says so, or if another tool call names it as its parent.
    parent_ids = {tc.parent_tool_call_id for tc in tool_calls if tc.parent_tool_call_id}
    for tool_call in tool_calls:
        if is_subagent_tool_id(tool_call.tool_id) or tool_call.tool_call_id in parent_ids:
            tool_call.is_agent = True

    return RawRequest(
        request_id=raw["requestId"],
        text=raw.get("message", {}).get("text", ""),
        timestamp_ms=raw["timestamp"],
        model_id=raw.get("modelId"),
        session_id=metadata.get("sessionId"),
        credits=raw.get("copilotCredits"),
        prompt_tokens=raw.get("promptTokens"),
        completion_tokens=raw.get("completionTokens"),
        time_spent_waiting_ms=raw.get("timeSpentWaiting"),
        elapsed_ms=raw.get("elapsedMs"),
        response_timestamp_ms=raw.get("responseTimestamp"),
        round_timestamps_ms=[r["timestamp"] for r in rounds if "timestamp" in r],
        tool_calls=tool_calls,
    )


def parse_export(data: dict[str, Any]) -> list[RawRequest]:
    """Parse the `requests` of an export (or a replayed live session)."""
    return [_parse_request(raw) for raw in data.get("requests", [])]


def _deduplicate_across_requests(requests: list[RawRequest]) -> None:
    """Drop a tool call from a later request if its id already appeared in an earlier request of the session.

    Copilot occasionally re-lists a long-running tool call (e.g. a background terminal command) under the
    same `toolCallId` in a follow-up turn; the request that first listed it keeps it.
    """
    seen_ids: set[str] = set()
    for request in requests:
        request.tool_calls = [tc for tc in request.tool_calls if tc.tool_call_id not in seen_ids]
        seen_ids.update(tc.tool_call_id for tc in request.tool_calls)


def parse_session_data(data: dict[str, Any], malformed_lines: int = 0) -> RawSession:
    """Parse a whole export (or replayed live session) including its session-level fields."""
    requests = parse_export(data)
    _deduplicate_across_requests(requests)
    session_id = next((r.session_id for r in requests if r.session_id), None) or data.get("sessionId")
    return RawSession(
        session_id=session_id,
        title=str(data.get("customTitle") or ""),
        creation_ms=data.get("creationDate"),
        requests=requests,
        malformed_lines=malformed_lines,
    )


def _apply_patch(snapshot: dict[str, Any], patch: dict[str, Any]) -> None:
    """Apply one entry: `kind` 1 replaces the value at `k`; `kind` 2 appends to (or splices via `i`) the array."""
    path = patch["k"]
    target: Any = snapshot
    for key in path[:-1]:
        target = target[key]
    last_key = path[-1]

    if patch["kind"] == 1:
        target[last_key] = patch["v"]
        return

    array = target[last_key]
    start = patch.get("i")
    if start is None:
        array.extend(patch.get("v", []))
    else:
        array[start:] = patch.get("v", [])


def _decode_line(line: str) -> tuple[list[dict[str, Any]], bool]:
    """Decode a JSONL line that may hold several JSON objects written back to back without a separator.

    Returns the decoded objects and whether the line was malformed: either an undecodable remainder was
    left on the line (objects decoded before it are kept), or a decoded value was not a JSON object.
    """
    decoder = json.JSONDecoder()
    objects: list[dict[str, Any]] = []
    malformed = False
    index = 0
    length = len(line)
    while index < length:
        while index < length and line[index].isspace():
            index += 1
        if index >= length:
            break
        try:
            value, index = decoder.raw_decode(line, index)
        except json.JSONDecodeError:
            malformed = True
            break
        if not isinstance(value, dict):
            malformed = True
            break
        objects.append(value)
    return objects, malformed


def _replay_live_session(lines: list[str]) -> tuple[dict[str, Any], int]:
    """Replay snapshot and patches; return the reconstructed data and the number of malformed lines skipped."""
    entries: list[dict[str, Any]] = []
    malformed_lines = 0
    for line in lines:
        if not line.strip():
            continue
        objects, malformed = _decode_line(line)
        entries.extend(objects)
        if malformed:
            malformed_lines += 1  # e.g. an in-progress write, or two records concatenated without a newline

    if not entries or entries[0].get("kind") != 0:
        raise ValueError("live session file must start with a kind:0 snapshot")

    snapshot = entries[0]["v"]
    for patch in entries[1:]:
        # Other patch kinds are deliberately ignored: not needed to reconstruct request data.
        if patch.get("kind") not in (1, 2):
            continue
        try:
            _apply_patch(snapshot, patch)
        except (KeyError, IndexError, TypeError):
            malformed_lines += 1  # e.g. a patch targeting a path dropped by an earlier malformed line
    return snapshot, malformed_lines


def load_session(path: Path) -> RawSession:
    """Load an export (`.json`) or a live `chatSessions` file (`.jsonl`)."""
    if path.suffix == ".json":
        return parse_session_data(json.loads(path.read_text()))
    snapshot, malformed_lines = _replay_live_session(path.read_text().splitlines())
    return parse_session_data(snapshot, malformed_lines=malformed_lines)
