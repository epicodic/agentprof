# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import shutil
from pathlib import Path

from agentprof.adapters.copilot_vscode.debuglog import DebugLlmCall, load_debug_log_dir

_FIXTURES = Path(__file__).parent / "fixtures"


def test_load_debug_log_dir_keys_root_calls_by_none() -> None:
    log = load_debug_log_dir(_FIXTURES / "debug_log", root_session_id="root_session")

    assert log.calls[None] == [
        DebugLlmCall(
            start_ms=1010,
            duration_ms=5,
            input_tokens=40000,
            output_tokens=300,
            cached_tokens=12000,
            debug_name="panel/editAgent",
            source_request_id="span_llm_root_1",
            model="claude-sonnet-5",
        )
    ]


def test_load_debug_log_dir_keys_child_and_grandchild_by_their_own_tool_call_id() -> None:
    log = load_debug_log_dir(_FIXTURES / "debug_log", root_session_id="root_session")

    assert [call.input_tokens for call in log.calls["call_lead"]] == [80000]
    # The grandchild's file header names the root as parent; its own `sid` still identifies it.
    assert [call.input_tokens for call in log.calls["call_grandchild"]] == [20000]
    assert log.malformed_lines == 0


def test_load_debug_log_dir_skips_and_counts_malformed_lines(tmp_path: Path) -> None:
    directory = tmp_path / "root_session"
    shutil.copytree(_FIXTURES / "debug_log", directory)
    with (directory / "main.jsonl").open("a") as main:
        main.write('{"type": "llm_request", "sid": "root_session"}\n{"broken\n[1, 2]\n')

    log = load_debug_log_dir(directory, root_session_id="root_session")

    assert log.malformed_lines == 3
    assert len(log.calls[None]) == 1


def test_load_debug_log_dir_leaves_missing_token_counts_unknown(tmp_path: Path) -> None:
    directory = tmp_path / "root_session"
    directory.mkdir()
    (directory / "main.jsonl").write_text(
        '{"ts": 5, "dur": 1, "sid": "root_session", "type": "llm_request", '
        '"attrs": {"debugName": "summarizeConversationHistory"}}\n'
    )

    log = load_debug_log_dir(directory, root_session_id="root_session")

    assert log.calls[None] == [
        DebugLlmCall(
            start_ms=5,
            duration_ms=1,
            input_tokens=None,
            output_tokens=None,
            cached_tokens=None,
            debug_name="summarizeConversationHistory",
        )
    ]


def test_debug_log_links_response_tools_and_input_results_to_request_spans(tmp_path: Path) -> None:
    import json

    directory = tmp_path / "root_session"
    directory.mkdir()
    records = [
        {
            "type": "agent_response",
            "sid": "root_session",
            "spanId": "agent-msg-span-1",
            "attrs": {
                "response": json.dumps([{"role": "assistant", "parts": [{"type": "tool_call", "id": "tool-1"}]}])
            },
        },
        {"type": "llm_request", "sid": "root_session", "spanId": "span-1", "ts": 10, "dur": 5, "attrs": {}},
        {
            "type": "llm_request",
            "sid": "root_session",
            "spanId": "span-2",
            "ts": 30,
            "dur": 5,
            "attrs": {
                "inputMessages": [
                    {"role": "user", "parts": [{"type": "tool_call_response", "id": "tool-1", "response": "output"}]}
                ]
            },
        },
        {
            "type": "agent_response",
            "sid": "child",
            "spanId": "agent-msg-span-1",
            "attrs": {
                "response": json.dumps([{"role": "assistant", "parts": [{"type": "tool_call", "id": "child-tool"}]}])
            },
        },
        {"type": "llm_request", "sid": "child", "spanId": "span-1", "ts": 10, "dur": 5, "attrs": {}},
    ]
    (directory / "records.jsonl").write_text("\n".join(json.dumps(record) for record in records))
    log = load_debug_log_dir(directory, "root_session")
    assert getattr(log.calls[None][0], "requested_tool_ids", ()) == ("tool-1",)
    assert getattr(log.calls[None][1], "consumed_tool_ids", ()) == ("tool-1",)
    assert getattr(log.calls["child"][0], "requested_tool_ids", ()) == ("child-tool",)
    assert log.malformed_lines == 0


def test_debug_log_preserves_complete_tool_ids_before_truncated_response_arguments(tmp_path: Path) -> None:
    import json

    directory = tmp_path / "root_session"
    directory.mkdir()
    response = '[{"role":"assistant","parts":[{"type":"tool_call","id":"tool-1","name":"Bash","arguments":"[truncated]'
    records = [
        {
            "type": "agent_response",
            "sid": "root_session",
            "spanId": "agent-msg-span-1",
            "attrs": {"response": response},
        },
        {"type": "llm_request", "sid": "root_session", "spanId": "span-1", "ts": 10, "dur": 5, "attrs": {}},
    ]
    (directory / "records.jsonl").write_text("\n".join(json.dumps(record) for record in records))
    assert getattr(load_debug_log_dir(directory, "root_session").calls[None][0], "requested_tool_ids", ()) == (
        "tool-1",
    )


def test_debug_log_retains_model_and_billing_including_zero(tmp_path: Path) -> None:
    import json

    attrs = [
        {"model": "claude-sonnet-5.5", "copilotUsageNanoAiu": 4946990000},
        {"model": "helper-model", "copilotUsageNanoAiu": 0},
        {},
    ]
    (tmp_path / "calls.jsonl").write_text(
        "\n".join(
            json.dumps({"type": "llm_request", "sid": "root", "ts": index, "attrs": value})
            for index, value in enumerate(attrs)
        )
    )
    calls = load_debug_log_dir(tmp_path, "root").calls[None]
    assert getattr(calls[0], "model", None) == "claude-sonnet-5.5"
    assert [getattr(call, "usage_nano_aiu", None) for call in calls] == [4946990000, 0, None]
    assert getattr(calls[2], "model", None) is None
