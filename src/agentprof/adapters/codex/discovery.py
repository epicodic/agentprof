# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Locate and group native Codex rollout files."""

import json
from dataclasses import dataclass
from pathlib import Path

from agentprof.adapters.codex.rollout import ThreadSpawn

_SNIFF_LINES = 20


@dataclass(frozen=True)
class RolloutFile:
    """Discovery metadata for one recognized rollout file."""

    path: Path
    session_id: str
    thread_id: str | None
    parent_thread_id: str | None
    agent_nickname: str | None
    thread_spawn: ThreadSpawn | None
    cwd: str | None


@dataclass(frozen=True)
class SessionFiles:
    """All rollout files and metadata belonging to one root Codex session."""

    session_id: str
    main: Path | None
    files: list[Path]
    rollouts: list[RolloutFile]


def default_sessions_root(home: Path) -> Path:
    """The default local Codex sessions directory."""
    return home / ".codex" / "sessions"


def read_metadata(path: Path) -> RolloutFile | None:
    """Read only through the first valid `session_meta`, without parsing rollout activity."""
    try:
        with path.open("rb") as lines:
            for _, raw_line in zip(range(_SNIFF_LINES), lines, strict=False):
                try:
                    line = raw_line.decode("utf-8")
                except UnicodeDecodeError:
                    continue
                metadata = _metadata_from_line(path, line)
                if metadata is not None:
                    return metadata
    except OSError:
        return None
    return None


def _metadata_from_line(path: Path, line: str) -> RolloutFile | None:
    try:
        entry = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(entry, dict) or entry.get("type") != "session_meta":
        return None
    payload = entry.get("payload")
    if not isinstance(payload, dict):
        return None
    session_id = _text(payload.get("session_id"))
    if session_id is None:
        return None
    source = payload.get("source")
    subagent = source.get("subagent") if isinstance(source, dict) else None
    spawn = _thread_spawn(subagent.get("thread_spawn")) if isinstance(subagent, dict) else None
    return RolloutFile(
        path=path,
        session_id=session_id,
        thread_id=_text(payload.get("id")),
        parent_thread_id=_text(payload.get("parent_thread_id")),
        agent_nickname=_text(payload.get("agent_nickname")),
        thread_spawn=spawn,
        cwd=_text(payload.get("cwd")),
    )


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


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


def session_files(root: Path) -> list[SessionFiles]:
    """Find nested recognized rollout JSONLs, grouped by root session ID."""
    if not root.is_dir():
        return []
    grouped: dict[str, list[RolloutFile]] = {}
    for path in sorted(root.glob("**/*.jsonl")):
        metadata = read_metadata(path)
        if metadata is not None:
            grouped.setdefault(metadata.session_id, []).append(metadata)
    return [_session_files(session_id, rollouts) for session_id, rollouts in sorted(grouped.items())]


def _session_files(session_id: str, rollouts: list[RolloutFile]) -> SessionFiles:
    main = next((rollout.path for rollout in rollouts if rollout.parent_thread_id is None), None)
    return SessionFiles(session_id, main, [rollout.path for rollout in rollouts], rollouts)
