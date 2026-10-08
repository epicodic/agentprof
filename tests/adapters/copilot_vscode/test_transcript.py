# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from pathlib import Path

from agentprof.adapters.copilot_vscode.transcript import load_transcript

_FIXTURES = Path(__file__).parent / "fixtures"
_T0 = 1790121600000  # 2026-09-23T00:00:00Z, the fixture's first event


def test_load_transcript_gives_absolute_start_end_and_success_per_tool_call() -> None:
    transcript = load_transcript(_FIXTURES / "transcript_basic.jsonl")

    timing = transcript.tool_timings["call_read_main"]
    assert timing.start_ms == _T0 + 40
    assert timing.end_ms == _T0 + 240
    assert timing.success is True
    assert transcript.tool_timings["call_term_child"].success is False


def test_load_transcript_keeps_tool_call_arguments() -> None:
    transcript = load_transcript(_FIXTURES / "transcript_basic.jsonl")

    assert transcript.tool_arguments["call_read_child"] == {"filePath": "bar.py"}
    assert transcript.tool_arguments["call_read_main"] == {}


def test_load_transcript_attributes_llm_calls_to_the_owning_agent_via_bracketing() -> None:
    transcript = load_transcript(_FIXTURES / "transcript_basic.jsonl")

    # The main agent (key None) issued the read_file and the runSubagent calls.
    assert transcript.llm_call_timestamps_ms[None] == [_T0 + 30, _T0 + 270]
    assert transcript.llm_call_timestamps_ms["call_lead"] == [_T0 + 300]
    # call_exec's own turn dispatched the two grandchildren in a single message.
    assert transcript.llm_call_timestamps_ms["call_exec"] == [_T0 + 320]
    # Leaf tool calls never own LLM calls themselves.
    assert "call_read_child" not in transcript.llm_call_timestamps_ms
    assert transcript.llm_call_source_request_ids[None] == ["m0", "m1"]
    assert transcript.tool_request_ids["call_read_main"] == "m0"


def test_load_transcript_retains_user_message_and_tool_completion_ordinals() -> None:
    transcript = load_transcript(_FIXTURES / "transcript_basic.jsonl")

    assert [
        (message.message_id, message.timestamp_ms, message.source_order) for message in transcript.user_messages
    ] == [("e1", _T0 + 10, 1)]
    timing = transcript.tool_timings["call_read_main"]
    assert timing.start_order == 4
    assert timing.completion_order == 5
    assert timing.completion_recorded is True


def test_load_transcript_retains_unaddressable_tool_records(tmp_path: Path) -> None:
    path = tmp_path / "transcript.jsonl"
    path.write_text(
        '{"type":"tool.execution_start","timestamp":"2026-09-23T00:00:00.040Z",'
        '"data":{"toolName":"read_file"}}\n'
        '{"type":"tool.execution_complete","timestamp":"2026-09-23T00:00:00.240Z",'
        '"data":{"success":true}}\n',
        encoding="utf-8",
    )

    transcript = load_transcript(path)

    assert [(record.kind, record.tool_call_id, record.source_order) for record in transcript.tool_events] == [
        ("tool.execution_start", None, 0),
        ("tool.execution_complete", None, 1),
    ]


def test_load_transcript_skips_and_counts_malformed_lines(tmp_path: Path) -> None:
    lines = (_FIXTURES / "transcript_basic.jsonl").read_text().splitlines()
    path = tmp_path / "transcript.jsonl"
    path.write_text("\n".join([lines[0], "not json", '{"type": "tool.execution_start"}', *lines[1:]]) + "\n")

    transcript = load_transcript(path)

    assert transcript.malformed_lines == 2
    assert transcript.tool_timings["call_read_main"].end_ms == _T0 + 240


def test_load_transcript_reads_timestamps_without_offset_as_utc(tmp_path: Path) -> None:
    path = tmp_path / "transcript.jsonl"
    path.write_text(
        '{"type": "tool.execution_start", "timestamp": "2026-09-23T00:00:00.040",'
        ' "data": {"toolCallId": "c1", "toolName": "read_file"}}\n'
    )

    transcript = load_transcript(path)

    assert transcript.tool_timings["c1"].start_ms == _T0 + 40
