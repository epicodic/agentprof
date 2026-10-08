# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import json
from pathlib import Path

from agentprof.adapters.claude_code.transcript import load_transcript
from agentprof.adapters.claude_code.tree import build_root
from agentprof.model import Metric
from agentprof.pricing import PriceTable

_PROJECT = Path(__file__).parent / "fixtures" / "projects" / "-home-user-demo"
_SESSION_ID = "11111111-1111-4111-8111-111111111111"
_MAIN = _PROJECT / f"{_SESSION_ID}.jsonl"
_SUBAGENTS = _PROJECT / _SESSION_ID / "subagents"
_T0 = 1789898400000  # 2026-09-20T10:00:00Z


def test_load_transcript_reads_title_cwd_and_first_timestamp() -> None:
    transcript = load_transcript(_MAIN)

    assert transcript.title == "Fix the parser"
    assert transcript.cwd == "/home/user/demo"
    assert transcript.first_timestamp_ms == _T0


def test_load_transcript_keeps_prompts_but_skips_meta_entries_and_tool_results() -> None:
    transcript = load_transcript(_MAIN)

    assert [(p.uuid, p.start_ms, p.text) for p in transcript.prompts] == [
        ("u1", _T0, "Fix the parser\nIt breaks on empty input"),
        ("u2", _T0 + 600_000, "Now run the tests"),
    ]


def test_load_transcript_merges_split_assistant_lines_into_one_call() -> None:
    transcript = load_transcript(_MAIN)

    first = transcript.messages[0]
    assert [m.message_id for m in transcript.messages] == [f"msg_{i}" for i in range(1, 8)]
    assert first.start_ms == _T0 + 1000
    assert first.model == "claude-sonnet-5"
    assert first.usage["output_tokens"] == 40  # the last line's usage wins


def test_load_transcript_collects_tool_uses_and_results() -> None:
    transcript = load_transcript(_MAIN)

    read = transcript.tool_uses[0]
    assert (read.tool_use_id, read.name, read.start_ms) == ("toolu_read1", "Read", _T0 + 1200)
    assert read.input["file_path"] == "/home/user/demo/parser.py"
    assert [t.tool_use_id for t in transcript.tool_uses] == [
        "toolu_read1",
        "toolu_agent1",
        "toolu_ask1",
        "toolu_bash1",
        "toolu_fancy1",
    ]
    bash = transcript.tool_results["toolu_bash1"]
    assert (bash.end_ms, bash.is_error, bash.text) == (_T0 + 605_000, True, "1 failed")
    assert transcript.tool_results["toolu_agent1"].text == "Tests use fixtures."
    assert "toolu_fancy1" not in transcript.tool_results


def test_load_transcript_counts_malformed_lines() -> None:
    assert load_transcript(_MAIN).malformed_lines == 1


def test_load_transcript_counts_non_object_lines_as_malformed(tmp_path: Path) -> None:
    path = tmp_path / "t.jsonl"
    path.write_text('[1, 2]\n{"type": "assistant"}\n', encoding="utf-8")

    transcript = load_transcript(path)

    assert transcript.malformed_lines == 2
    assert transcript.messages == []


def test_load_transcript_records_bounded_redacted_malformed_line_details(tmp_path: Path) -> None:
    path = tmp_path / "private.jsonl"
    secret = "private-token-123"
    path.write_text(
        "\n".join(['{"type":"assistant","message":"' + secret + '"', "[1, 2]", '{"type":"assistant"}'] * 8) + "\n",
        encoding="utf-8",
    )

    transcript = load_transcript(path)

    assert transcript.malformed_lines == 24
    assert len(transcript.malformed_line_details) == 20
    assert [(detail.line_number, detail.error_category) for detail in transcript.malformed_line_details[:3]] == [
        (1, "invalid_json"),
        (2, "non_object"),
        (3, "missing_field"),
    ]
    assert all(detail.source_path == str(path) for detail in transcript.malformed_line_details)
    assert all(len(detail.excerpt) <= 120 for detail in transcript.malformed_line_details)
    assert all(secret not in detail.excerpt for detail in transcript.malformed_line_details)
    assert '"[redacted]"' in transcript.malformed_line_details[0].excerpt


def test_load_transcript_omits_blank_lines_from_malformed_details(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    path.write_text("\n  \n{broken\n", encoding="utf-8")

    transcript = load_transcript(path)

    assert transcript.malformed_lines == 1
    assert transcript.malformed_line_details[0].line_number == 3


def test_load_transcript_bounds_excerpt_for_long_private_value(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    secret = "very-private-" * 100
    path.write_text('{"message":"' + secret + '"', encoding="utf-8")

    detail = load_transcript(path).malformed_line_details[0]

    assert len(detail.excerpt) <= 120
    assert secret[:20] not in detail.excerpt
    assert detail.excerpt.endswith("…")


def test_load_transcript_bounds_excerpt_for_long_malformed_structure(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    path.write_text("{" * 200, encoding="utf-8")

    detail = load_transcript(path).malformed_line_details[0]

    assert len(detail.excerpt) <= 120
    assert detail.excerpt.endswith("…")


def test_load_transcript_reads_a_subagent_file() -> None:
    transcript = load_transcript(_SUBAGENTS / "agent-aaa.jsonl")

    assert transcript.prompts[0].text == "Look at the tests"
    assert [m.message_id for m in transcript.messages] == ["msg_a1", "msg_a2", "msg_a3", "msg_a4"]
    assert transcript.title is None


def test_last_message_ignores_tool_results(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    path.write_text(
        "\n".join(
            [
                '{"type":"assistant","timestamp":"2026-09-20T10:00:00Z","uuid":"a","message":{"id":"m","content":[]}}',
                '{"type":"user","timestamp":"2026-09-20T10:00:01Z","uuid":"r","message":{"content":[{"type":"tool_result","tool_use_id":"t"}]}}',
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    assert load_transcript(path).last_message_ms == _T0


def test_load_transcript_records_compaction_boundaries() -> None:
    transcript = load_transcript(_MAIN)

    assert len(transcript.compactions_ms) == 1
    assert transcript.prompts[0].start_ms < transcript.compactions_ms[0] < transcript.prompts[1].start_ms


def test_load_transcript_keeps_request_and_result_sequence_across_split_message(tmp_path: Path) -> None:
    path = tmp_path / "11111111-1111-4111-8111-111111111111.jsonl"
    session_id = "11111111-1111-4111-8111-111111111111"

    def record(
        kind: str, timestamp: str, uuid: str, content: object, message_id: str | None = None
    ) -> dict[str, object]:
        message: dict[str, object] = {"role": "user" if kind == "user" else "assistant", "content": content}
        if message_id is not None:
            message.update(
                {
                    "id": message_id,
                    "type": "message",
                    "model": "claude-sonnet-5",
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                }
            )
        return {
            "uuid": uuid,
            "timestamp": timestamp,
            "sessionId": session_id,
            "cwd": "/home/user/demo",
            "isSidechain": False,
            "version": "2.1.200",
            "type": kind,
            "message": message,
        }

    entries = [
        record("user", "2026-09-20T10:00:01.000Z", "u1", "prompt"),
        record("assistant", "2026-09-20T10:00:01.100Z", "a1", [{"type": "text", "text": "working"}], "m1"),
        record(
            "assistant",
            "2026-09-20T10:00:01.200Z",
            "a2",
            [{"type": "tool_use", "id": "t1", "name": "Read", "input": {}}],
            "m1",
        ),
        record(
            "assistant",
            "2026-09-20T10:00:01.300Z",
            "a3",
            [{"type": "tool_use", "id": "t2", "name": "Bash", "input": {}}],
            "m1",
        ),
        record(
            "user",
            "2026-09-20T10:00:01.500Z",
            "r2",
            [{"type": "tool_result", "tool_use_id": "t2", "is_error": True, "content": ""}],
        ),
        record("assistant", "2026-09-20T10:00:01.600Z", "a4", [], "m1"),
        record(
            "user",
            "2026-09-20T10:00:01.700Z",
            "r1",
            [{"type": "tool_result", "tool_use_id": "t1", "is_error": False, "content": "ok"}],
        ),
        record("assistant", "2026-09-20T10:00:01.800Z", "a5", [{"type": "text", "text": "done"}], "m2"),
    ]
    path.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n", encoding="utf-8")

    transcript = load_transcript(path)

    assert len(transcript.messages) == 2
    assert transcript.tool_uses[0].request_message_id == "m1"
    assert transcript.tool_uses[1].request_message_id == "m1"
    assert transcript.tool_results["t2"].next_message_id == "m2"
    assert transcript.tool_results["t2"].text == ""
    assert transcript.tool_results["t2"].is_error is True
    assert transcript.tool_results["t1"].next_message_id == "m2"
    assert [invocation_id for invocation_id, _ in transcript.tool_result_records] == ["t2", "t1"]

    root = build_root(transcript, [], PriceTable.load(), "sequence")
    result_events = [event for event in root.children[0].execution_events if event.kind == "tool_result"]

    assert len(result_events) == 2
    failed_result = next(event for event in result_events if event.event_id == "tool-result:t2")
    assert failed_result.start == Metric.exact(1789898401500)
    assert failed_result.success is False
    assert [(link.source_request_id, link.relation, link.evidence) for link in failed_result.links] == [
        ("m1", "requested_by", "recorded"),
        ("m2", "next_observed_call", "observed_order"),
    ]
    assert all(
        [(link.source_request_id, link.relation) for link in event.links][-1] == ("m2", "next_observed_call")
        for event in result_events
    )
