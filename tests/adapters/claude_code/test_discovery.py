# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from pathlib import Path

from agentprof.adapters.claude_code.discovery import (
    SubagentMeta,
    default_projects_root,
    load_subagents,
    read_meta,
    session_files,
)

_PROJECTS = Path(__file__).parent / "fixtures" / "projects"
_SESSION_ID = "11111111-1111-4111-8111-111111111111"
_MAIN = _PROJECTS / "-home-user-demo" / f"{_SESSION_ID}.jsonl"


def test_default_projects_root_uses_the_home_directory(tmp_path: Path) -> None:
    assert default_projects_root({}, tmp_path) == tmp_path / ".claude" / "projects"


def test_default_projects_root_honours_claude_config_dir(tmp_path: Path) -> None:
    assert default_projects_root({"CLAUDE_CONFIG_DIR": "/cfg"}, tmp_path) == Path("/cfg/projects")


def test_session_files_lists_main_transcripts_only() -> None:
    assert session_files(_PROJECTS) == [_MAIN]


def test_session_files_of_a_missing_root_is_empty(tmp_path: Path) -> None:
    assert session_files(tmp_path / "missing") == []


def test_load_subagents_pairs_transcripts_with_their_meta() -> None:
    subagents = load_subagents(_MAIN)

    assert [s.meta.agent_id for s in subagents] == ["aaa", "bbb", "ccc"]
    assert subagents[0].meta == SubagentMeta(
        agent_id="aaa",
        tool_use_id="toolu_agent1",
        agent_type="general-purpose",
        description="Investigate tests",
        model="claude-haiku-4-5-20251001",
    )
    assert subagents[0].transcript.prompts[0].text == "Look at the tests"
    assert subagents[2].meta == SubagentMeta(
        agent_id="ccc", tool_use_id=None, agent_type=None, description=None, model=None
    )


def test_read_meta_tolerates_invalid_json(tmp_path: Path) -> None:
    path = tmp_path / "agent-x.meta.json"
    path.write_text("not json", encoding="utf-8")

    assert read_meta("x", path).tool_use_id is None
