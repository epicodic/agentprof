# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from pathlib import Path

from agentprof.adapters.codex.rollout import UsageRecord, load_rollout
from agentprof.adapters.timestamps import parse_iso_ms

_ROOT = Path(__file__).parent / "fixtures/sessions/2026/09/26/rollout-2026-09-26T10-00-00-root.jsonl"


def test_load_rollout_reads_main_turns_tools_and_usage() -> None:
    rollout = load_rollout(_ROOT)

    assert rollout.session_id == "root-session"
    assert rollout.cwd == "/work/demo"
    assert [turn.turn_id for turn in rollout.turns] == ["turn-1", "turn-2"]
    assert rollout.turns[0].usage == UsageRecord(input=20, cache_read=60, cache_write=20, output=30)
    assert [tool.name for tool in rollout.turns[0].tools] == ["exec_command", "apply_patch", "spawn_agent"]
    assert [tool.output for tool in rollout.turns[0].tools] == [
        "README.md\nsrc/main.py",
        "Done!",
        '{"status":"success"}',
    ]
    assert rollout.turns[1].usage == UsageRecord(input=30, cache_read=10, cache_write=0, output=12)
    assert [tool.name for tool in rollout.turns[1].tools] == ["functions.exec_command"]
    assert rollout.turns[1].tools[0].input == '{"cmd":"git status --short"}'
    assert rollout.turns[1].tools[0].output == "Synthetic command output."


def test_load_rollout_retains_subagent_identity_and_usage_record_details() -> None:
    agent = load_rollout(Path(__file__).parent / "fixtures/sessions/2026/09/26/rollout-2026-09-26T10-00-10-agent.jsonl")

    assert agent.thread_id == "agent-thread"
    assert agent.agent_nickname == "Researcher"
    assert agent.thread_spawn is not None
    assert agent.thread_spawn.agent_path == "researcher"
    usage = agent.turns[0].token_usages[0]
    assert usage.usage == UsageRecord(input=20, cache_read=5, cache_write=0, output=9)
    assert usage.response_id == "agent-response-1"
    assert usage.timestamp_ms == parse_iso_ms("2026-09-26T10:00:11.500Z")


def test_load_rollout_retains_tool_output_status(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    path.write_text(
        "\n".join(
            [
                '{"type":"session_meta","payload":{"session_id":"session"}}',
                '{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}',
                '{"type":"response_item","payload":{"type":"function_call","call_id":"call","name":"exec_command","arguments":"{}"}}',
                '{"type":"response_item","payload":{"type":"function_call_output","call_id":"call","output":"failed","status":"failed"}}',
            ]
        ),
        encoding="utf-8",
    )

    tool = load_rollout(path).turns[0].tools[0]

    assert tool.output == "failed"
    assert tool.output_status == "failed"


def test_load_rollout_distinguishes_empty_result_from_open_tool(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    path.write_text(
        "\n".join(
            [
                '{"type":"event_msg","ordinal":0,"payload":{"type":"task_started","turn_id":"turn"}}',
                '{"type":"response_item","ordinal":1,"timestamp":"2026-09-26T10:00:00.100Z",'
                '"payload":{"type":"function_call","call_id":"empty","name":"exec","arguments":"{}"}}',
                '{"type":"response_item","ordinal":2,"timestamp":"2026-09-26T10:00:00.200Z",'
                '"payload":{"type":"function_call_output","call_id":"empty","output":""}}',
                '{"type":"response_item","ordinal":3,"timestamp":"2026-09-26T10:00:00.300Z",'
                '"payload":{"type":"function_call","name":"open","arguments":"{}"}}',
            ]
        ),
        encoding="utf-8",
    )

    empty, opened = load_rollout(path).turns[0].tools

    assert empty.result_recorded is True
    assert empty.output == ""
    assert (empty.start_order, empty.result_order) == (1, 2)
    assert opened.result_recorded is False
    assert opened.call_id is None


def test_load_rollout_retains_unmatched_result_record_without_inventing_a_tool(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    path.write_text(
        '{"type":"event_msg","ordinal":0,"payload":{"type":"task_started","turn_id":"turn"}}\n'
        '{"type":"response_item","ordinal":1,"timestamp":"2026-09-26T10:00:00.200Z",'
        '"payload":{"type":"function_call_output","output":"orphan output"}}\n',
        encoding="utf-8",
    )

    turn = load_rollout(path).turns[0]

    assert turn.tools == []
    assert len(turn.unmatched_tool_results) == 1
    assert turn.unmatched_tool_results[0].call_id is None
    assert turn.unmatched_tool_results[0].timestamp_ms == parse_iso_ms("2026-09-26T10:00:00.200Z")


def test_load_rollout_skips_invalid_utf8_lines_after_valid_records(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    path.write_bytes(
        b'{"type":"session_meta","payload":{"session_id":"session"}}\n'
        b'{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}\n'
        b"\xff\n"
    )

    rollout = load_rollout(path)

    assert rollout.session_id == "session"
    assert [turn.turn_id for turn in rollout.turns] == ["turn"]
    assert rollout.malformed_lines == 1
