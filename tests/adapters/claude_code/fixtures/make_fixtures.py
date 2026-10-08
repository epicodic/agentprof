# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Regenerate the synthetic Claude Code session used by the tests.

Run: `uv run python tests/adapters/claude_code/fixtures/make_fixtures.py`
"""

import json
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

SESSION_ID = "11111111-1111-4111-8111-111111111111"
_T0 = datetime(2026, 9, 20, 10, 0, 0, tzinfo=UTC)
_PROJECTS = Path(__file__).parent / "projects"
_PROJECT = _PROJECTS / "-home-user-demo"
_CWD = "/home/user/demo"
_SONNET = "claude-sonnet-5"
_HAIKU = "claude-haiku-4-5-20251001"
_SMALL_USAGE = {"input_tokens": 10, "output_tokens": 10, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}


def _timestamp(seconds: float) -> str:
    return (_T0 + timedelta(seconds=seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _base(uuid: str, seconds: float, sidechain: bool) -> dict[str, Any]:
    return {
        "uuid": uuid,
        "timestamp": _timestamp(seconds),
        "sessionId": SESSION_ID,
        "cwd": _CWD,
        "isSidechain": sidechain,
        "version": "2.1.200",
    }


def _prompt(
    uuid: str, seconds: float, content: object, *, sidechain: bool = False, meta: bool = False
) -> dict[str, Any]:
    entry = {**_base(uuid, seconds, sidechain), "type": "user", "message": {"role": "user", "content": content}}
    if meta:
        entry["isMeta"] = True
    return entry


def _assistant(
    uuid: str,
    seconds: float,
    message_id: str,
    model: str,
    content: list[dict[str, Any]],
    usage: dict[str, Any] | None = None,
    *,
    sidechain: bool = False,
) -> dict[str, Any]:
    message = {"id": message_id, "type": "message", "role": "assistant", "model": model, "content": content}
    message["usage"] = usage if usage is not None else _SMALL_USAGE
    return {**_base(uuid, seconds, sidechain), "type": "assistant", "message": message}


def _tool_use(tool_use_id: str, name: str, tool_input: dict[str, Any]) -> dict[str, Any]:
    return {"type": "tool_use", "id": tool_use_id, "name": name, "input": tool_input}


def _text(value: str) -> dict[str, Any]:
    return {"type": "text", "text": value}


def _tool_result(
    uuid: str, seconds: float, tool_use_id: str, content: object, *, is_error: bool = False, sidechain: bool = False
) -> dict[str, Any]:
    block = {"type": "tool_result", "tool_use_id": tool_use_id, "content": content, "is_error": is_error}
    return {**_base(uuid, seconds, sidechain), "type": "user", "message": {"role": "user", "content": [block]}}


def _main_lines() -> list[str]:
    first_usage = {
        "input_tokens": 100,
        "output_tokens": 5,
        "cache_read_input_tokens": 1000,
        "cache_creation_input_tokens": 500,
        "cache_creation": {"ephemeral_5m_input_tokens": 500, "ephemeral_1h_input_tokens": 0},
    }
    entries = [
        {"type": "ai-title", "aiTitle": "Fix the parser", "sessionId": SESSION_ID},
        _prompt("u1", 0, "Fix the parser\nIt breaks on empty input"),
        _prompt("u-meta", 0.5, "<local-command-caveat>ignore</local-command-caveat>", meta=True),
        _assistant("a1", 1, "msg_1", _SONNET, [_text("Let me look.")], first_usage),
        _assistant(
            "a2",
            1.2,
            "msg_1",
            _SONNET,
            [_tool_use("toolu_read1", "Read", {"file_path": "/home/user/demo/parser.py", "offset": 10, "limit": 20})],
            {**first_usage, "output_tokens": 40},
        ),
        _tool_result("r1", 2, "toolu_read1", "   10\tdef parse():"),
        _assistant(
            "a3",
            3,
            "msg_2",
            _SONNET,
            [
                _tool_use(
                    "toolu_agent1",
                    "Agent",
                    {
                        "description": "Investigate tests",
                        "subagent_type": "general-purpose",
                        "prompt": "Look at the tests",
                    },
                )
            ],
        ),
        _tool_result("r2", 60, "toolu_agent1", [_text("Tests use fixtures.")]),
        _assistant("a4", 61, "msg_3", _SONNET, [_tool_use("toolu_ask1", "AskUserQuestion", {"questions": []})]),
        _tool_result("r3", 91, "toolu_ask1", "User chose A"),
        _assistant("a5", 92, "msg_4", _SONNET, [_text("Done.")]),
        {
            **_base("s1", 93, False),
            "type": "system",
            "subtype": "compact_boundary",
            "content": "Conversation compacted",
        },
        _prompt("u2", 600, [_text("Now run the tests")]),
        _assistant(
            "a6",
            601,
            "msg_5",
            _SONNET,
            [_tool_use("toolu_bash1", "Bash", {"command": "uv run pytest", "description": "Run tests"})],
        ),
        _tool_result("r4", 605, "toolu_bash1", "1 failed", is_error=True),
        _assistant("a7", 606, "msg_6", "claude-unknown-9", [_text("Hmm.")]),
        _assistant("a8", 607, "msg_7", _SONNET, [_tool_use("toolu_fancy1", "FancyNewTool", {})]),
    ]
    lines = [json.dumps(entry) for entry in entries]
    lines.insert(12, "{broken")  # a malformed line between the compact boundary and the second prompt
    return lines


def _subagent_aaa_lines() -> list[str]:
    first_usage = {
        "input_tokens": 20,
        "output_tokens": 5,
        "cache_read_input_tokens": 300,
        "cache_creation_input_tokens": 200,
        "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 200},
    }
    entries = [
        _prompt("aaa-u1", 3.5, "Look at the tests", sidechain=True),
        _assistant(
            "aaa-a1",
            4,
            "msg_a1",
            _HAIKU,
            [_tool_use("toolu_grep1", "Grep", {"pattern": "def test_"})],
            first_usage,
            sidechain=True,
        ),
        _tool_result("aaa-r1", 5, "toolu_grep1", "tests/test_parser.py", sidechain=True),
        _assistant(
            "aaa-a2",
            6,
            "msg_a2",
            _HAIKU,
            [
                _tool_use(
                    "toolu_agent2",
                    "Agent",
                    {"description": "Check fixtures", "subagent_type": "Explore", "prompt": "List fixtures"},
                )
            ],
            sidechain=True,
        ),
        _tool_result("aaa-r2", 50, "toolu_agent2", "3 fixtures", sidechain=True),
        _assistant("aaa-a3", 55, "msg_a3", _HAIKU, [_text("Tests use fixtures.")], sidechain=True),
        _assistant("aaa-a4", 700, "msg_a4", _HAIKU, [_text("Follow-up done.")], sidechain=True),
    ]
    return [json.dumps(entry) for entry in entries]


def _subagent_bbb_lines() -> list[str]:
    entries = [
        _prompt("bbb-u1", 6.5, "List fixtures", sidechain=True),
        _assistant(
            "bbb-a1", 7, "msg_b1", _HAIKU, [_tool_use("toolu_poll1", "BashOutput", {"bash_id": "x"})], sidechain=True
        ),
        _tool_result("bbb-r1", 8, "toolu_poll1", "running", sidechain=True),
        _assistant("bbb-a2", 9, "msg_b2", _HAIKU, [_text("3 fixtures")], sidechain=True),
    ]
    return [json.dumps(entry) for entry in entries]


def _subagent_ccc_lines() -> list[str]:
    entries = [
        _prompt("ccc-u1", 650, "Background check", sidechain=True),
        _assistant("ccc-a1", 651, "msg_c1", _SONNET, [_text("All good.")], sidechain=True),
    ]
    return [json.dumps(entry) for entry in entries]


def _write(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    shutil.rmtree(_PROJECTS, ignore_errors=True)
    _write(_PROJECT / f"{SESSION_ID}.jsonl", _main_lines())
    subagents = _PROJECT / SESSION_ID / "subagents"
    _write(subagents / "agent-aaa.jsonl", _subagent_aaa_lines())
    meta_aaa = {
        "agentType": "general-purpose",
        "description": "Investigate tests",
        "toolUseId": "toolu_agent1",
        "model": _HAIKU,
    }
    _write(subagents / "agent-aaa.meta.json", [json.dumps(meta_aaa)])
    _write(subagents / "agent-bbb.jsonl", _subagent_bbb_lines())
    meta_bbb = {"agentType": "Explore", "description": "Check fixtures", "toolUseId": "toolu_agent2", "spawnDepth": 2}
    _write(subagents / "agent-bbb.meta.json", [json.dumps(meta_bbb)])
    _write(subagents / "agent-ccc.jsonl", _subagent_ccc_lines())  # orphan: no meta.json


if __name__ == "__main__":
    main()
