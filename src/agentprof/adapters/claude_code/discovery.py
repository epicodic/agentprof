# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Locate Claude Code session files and their subagent transcripts."""

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from agentprof.adapters.claude_code.transcript import Transcript, load_transcript

_AGENT_PREFIX = "agent-"


@dataclass(frozen=True)
class SubagentMeta:
    """Contents of `agent-<id>.meta.json`; `tool_use_id` names the `Agent` call that spawned the subagent."""

    agent_id: str
    tool_use_id: str | None
    agent_type: str | None
    description: str | None
    model: str | None


@dataclass
class Subagent:
    meta: SubagentMeta
    transcript: Transcript


def default_projects_root(env: Mapping[str, str], home: Path) -> Path:
    """`$CLAUDE_CONFIG_DIR/projects` if set, else `~/.claude/projects`."""
    config_dir = env.get("CLAUDE_CONFIG_DIR")
    return (Path(config_dir) if config_dir else home / ".claude") / "projects"


def session_files(root: Path) -> list[Path]:
    """Main transcripts: `<root>/<project-dir>/<session-id>.jsonl` (subagent files sit deeper)."""
    return sorted(root.glob("*/*.jsonl"))


def subagent_dir(session_file: Path) -> Path:
    """`<project-dir>/<session-id>/subagents/`, next to the main transcript."""
    return session_file.parent / session_file.stem / "subagents"


def read_meta(agent_id: str, meta_file: Path) -> SubagentMeta:
    """Read a subagent's meta file; missing or invalid files yield a meta without spawning call."""
    try:
        data = json.loads(meta_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}

    def text(key: str) -> str | None:
        value = data.get(key)
        return value if isinstance(value, str) and value else None

    return SubagentMeta(
        agent_id=agent_id,
        tool_use_id=text("toolUseId"),
        agent_type=text("agentType"),
        description=text("description"),
        model=text("model"),
    )


def load_subagents(session_file: Path) -> list[Subagent]:
    """Parse every subagent transcript of a session, flat regardless of nesting depth."""
    directory = subagent_dir(session_file)
    subagents: list[Subagent] = []
    for path in sorted(directory.glob(f"{_AGENT_PREFIX}*.jsonl")):
        agent_id = path.stem.removeprefix(_AGENT_PREFIX)
        subagents.append(
            Subagent(meta=read_meta(agent_id, path.with_suffix(".meta.json")), transcript=load_transcript(path))
        )
    return subagents
