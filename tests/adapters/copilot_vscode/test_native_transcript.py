# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import json
from pathlib import Path
from typing import Any

import pytest

from agentprof.adapters.copilot_vscode.debuglog import load_debug_log_dir
from agentprof.adapters.copilot_vscode.session import parse_session_data
from agentprof.adapters.copilot_vscode.transcript import load_transcript
from agentprof.adapters.copilot_vscode.tree import build_root
from agentprof.model import Provenance, iter_nodes, transcript_entry_id
from agentprof.server.transcript_schema import transcript_detail_out

_FIXTURES = Path(__file__).parent / "fixtures"


def _entry(kind: str, index: int, data: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {
        "id": f"event-{index}",
        "type": kind,
        "timestamp": f"2026-09-23T00:00:{index:02d}.000Z",
        "data": data,
        **extra,
    }


def _tree(tmp_path: Path, events: list[dict[str, Any]], export: dict[str, Any] | None = None):
    transcript_path = tmp_path / "sid.jsonl"
    transcript_path.write_text("\n".join(json.dumps(event) for event in events), encoding="utf-8")
    raw = parse_session_data(export or json.loads((_FIXTURES / "export_basic.json").read_text()))
    return build_root(raw, load_transcript(transcript_path), None, 0.01)


def test_transcript_retains_messages_reasoning_and_unknown_typed_parts(tmp_path: Path) -> None:
    events = [
        _entry("session.start", 0, {"sessionId": "sid"}),
        _entry("user.message", 1, {"content": "question"}),
        _entry(
            "assistant.message",
            2,
            {
                "messageId": "msg-1",
                "content": [
                    {"type": "text", "text": "answer"},
                    {"type": "reasoning", "text": "because"},
                    {"type": "opaque", "payload": {"kept": True}},
                ],
                "toolRequests": [],
            },
        ),
    ]

    root = _tree(tmp_path, events)
    entries = [
        entry
        for node in iter_nodes(root)
        for entry in node.transcript_entries
        if entry.source_stream_id.startswith("copilot-transcript:")
    ]

    assert [
        (entry.kind, entry.native_id) for entry in entries if entry.kind in ("user_message", "assistant_message")
    ] == [
        ("user_message", "event-1"),
        ("assistant_message", "msg-1"),
    ]
    assistant = next(entry for entry in entries if entry.kind == "assistant_message")
    assert [(block.kind, block.text, block.availability) for block in assistant.blocks] == [
        ("message", "answer", "recorded"),
        ("reasoning", "because", "recorded"),
        ("other", None, "unsupported"),
    ]
    assert assistant.blocks[2].data == {"type": "opaque", "payload": {"kept": True}}
    user = next(entry for entry in entries if entry.kind == "user_message")
    assert user.blocks[0].text == "question"


def test_transcript_retains_only_nonempty_message_participants(tmp_path: Path) -> None:
    events = [
        _entry("user.message", 0, {"content": "question", "sender": "worker-1", "recipient": "main"}),
        _entry("assistant.message", 1, {"content": "answer", "author": "worker-2", "recipient": "worker-1"}),
        _entry("assistant.message", 2, {"content": "anonymous", "sender": "", "author": 7, "recipient": []}),
        _entry(
            "tool.execution_start",
            3,
            {"toolName": "runCommand", "toolCallId": "tool-1", "arguments": {"sender": "argument"}, "sender": "tool"},
        ),
        _entry("other.event", 4, {"sender": "event", "author": "event-author", "recipient": "event-recipient"}),
    ]

    root = _tree(tmp_path, events)
    entries = [entry for node in iter_nodes(root) for entry in node.transcript_entries]
    user = next(entry for entry in entries if entry.kind == "user_message")
    assistant = next(entry for entry in entries if entry.blocks[0].text == "answer")
    anonymous = next(entry for entry in entries if entry.blocks[0].text == "anonymous")
    tool = next(entry for entry in entries if entry.kind == "tool_request")
    unrelated = next(entry for entry in entries if entry.blocks[0].native_type == "other.event")

    assert (user.sender, user.recipient) == ("worker-1", "main")
    assert (assistant.sender, assistant.recipient) == ("worker-2", "worker-1")
    assert (anonymous.sender, anonymous.recipient) == (None, None)
    assert (tool.sender, tool.recipient) == (None, None)
    assert (unrelated.sender, unrelated.recipient) == (None, None)


def test_transcript_retains_empty_message_and_tool_output_availability(tmp_path: Path) -> None:
    events = [
        _entry("session.start", 0, {"sessionId": "sid"}),
        _entry(
            "assistant.message",
            1,
            {
                "messageId": "m",
                "content": "",
                "toolRequests": [
                    {
                        "toolCallId": "call_read_main",
                        "name": "read_file",
                        "arguments": {"x": 1, "ciphertext": "literal"},
                    }
                ],
            },
        ),
        _entry(
            "tool.execution_start",
            2,
            {"toolCallId": "call_read_main", "toolName": "read_file", "arguments": {"x": 1, "ciphertext": "literal"}},
        ),
        _entry("tool.execution_complete", 3, {"toolCallId": "call_read_main", "success": True}),
        _entry("tool.execution_start", 4, {"toolCallId": "call_lead", "toolName": "runSubagent", "arguments": {}}),
        _entry("tool.execution_complete", 5, {"toolCallId": "call_lead", "success": True, "output": ""}),
    ]

    root = _tree(tmp_path, events)
    nodes = {node.node_id: node for node in iter_nodes(root)}
    entries = [
        entry
        for node in nodes.values()
        for entry in node.transcript_entries
        if entry.source_stream_id.startswith("copilot-transcript:")
    ]
    by_kind = {entry.kind: entry for entry in entries}

    assert by_kind["assistant_message"].blocks[0].text == ""
    read_request = next(
        entry for entry in entries if entry.kind == "tool_request" and entry.invocation_id == "call_read_main"
    )
    read_result = next(
        entry for entry in entries if entry.kind == "tool_result" and entry.invocation_id == "call_read_main"
    )
    assert read_request.blocks[0].data == {"x": 1, "ciphertext": "literal"}
    assert read_result.blocks[0].availability == "unavailable"
    assert read_result.blocks[0].data is None
    assert read_result.owner_id == "request_001"
    empty_output = [entry for entry in entries if entry.invocation_id == "call_lead" and entry.kind == "tool_result"]
    assert empty_output[0].blocks[0].text == ""
    assert empty_output[0].blocks[0].availability == "recorded"


@pytest.mark.parametrize("body_key", ["output", "result", "content"])
def test_null_tool_completion_body_is_unavailable_in_transcript_detail(tmp_path: Path, body_key: str) -> None:
    events = [
        _entry("session.start", 0, {"sessionId": "sid"}),
        _entry("tool.execution_start", 1, {"toolCallId": "call", "toolName": "read_file", "arguments": {}}),
        _entry("tool.execution_complete", 2, {"toolCallId": "call", body_key: None}),
    ]

    root = _tree(tmp_path, events)
    completion = next(
        entry
        for node in iter_nodes(root)
        for entry in node.transcript_entries
        if entry.kind == "tool_result" and entry.invocation_id == "call"
    )
    detail = transcript_detail_out(root, completion)

    assert detail.coverage.source_present is True
    assert detail.coverage.categories == ["transcript", "export"]
    assert detail.coverage.reasons == []
    assert detail.block_availability == ["unavailable"]
    assert detail.blocks[0].native_type == body_key
    assert detail.blocks[0].availability == "unavailable"
    assert detail.blocks[0].text is None
    assert detail.blocks[0].data is None


@pytest.mark.parametrize("body_key", ["output", "result", "content"])
@pytest.mark.parametrize("body", [{"path": "file.txt"}, ["one", 2], 42, False])
def test_structured_tool_completion_body_remains_recorded_in_transcript_detail(
    tmp_path: Path, body_key: str, body: object
) -> None:
    events = [
        _entry("session.start", 0, {"sessionId": "sid"}),
        _entry("tool.execution_start", 1, {"toolCallId": "call", "toolName": "read_file", "arguments": {}}),
        _entry("tool.execution_complete", 2, {"toolCallId": "call", body_key: body}),
    ]

    root = _tree(tmp_path, events)
    completion = next(
        entry
        for node in iter_nodes(root)
        for entry in node.transcript_entries
        if entry.kind == "tool_result" and entry.invocation_id == "call"
    )
    detail = transcript_detail_out(root, completion)

    assert detail.block_availability == ["recorded"]
    assert detail.blocks[0].native_type == body_key
    assert detail.blocks[0].availability == "recorded"
    assert detail.blocks[0].text is None
    assert detail.blocks[0].data == body


def test_transcript_keeps_physical_order_and_marks_ambiguous_ownership(tmp_path: Path) -> None:
    events = [
        _entry("session.start", 0, {"sessionId": "sid"}),
        _entry("tool.execution_start", 1, {"toolCallId": "call_lead", "toolName": "runSubagent", "arguments": {}}),
        _entry(
            "tool.execution_start", 2, {"toolCallId": "call_exec", "toolName": "execution_subagent", "arguments": {}}
        ),
        _entry("assistant.message", 3, {"messageId": "child-msg", "content": "child", "toolRequests": []}),
        _entry("tool.execution_start", 4, {"toolCallId": "call_read_main", "toolName": "read_file", "arguments": {}}),
        _entry(
            "assistant.message",
            5,
            {"messageId": "ambiguous", "content": "interleaved", "toolRequests": []},
            parentId="unknown",
        ),
    ]
    events[2]["timestamp"] = "2026-09-23T00:00:01.000Z"
    events[3]["timestamp"] = "2026-09-23T00:00:00.500Z"

    root = _tree(tmp_path, events)
    entries = [entry for node in iter_nodes(root) for entry in node.transcript_entries]
    by_id = {entry.native_id: entry for entry in entries}

    assert by_id["child-msg"].source_position == 3
    assert by_id["child-msg"].owner_id == "call_exec"
    assert by_id["child-msg"].ownership_evidence == "bracket"
    assert by_id["ambiguous"].owner_id == "session"
    assert by_id["ambiguous"].ownership_evidence == "ambiguous"
    assert by_id["child-msg"].source_stream_id == by_id["ambiguous"].source_stream_id
    assert by_id["child-msg"].logical_stream_id != by_id["ambiguous"].logical_stream_id


def test_export_preserves_ordered_response_parts_and_live_replay_keeps_content() -> None:
    data = json.loads((_FIXTURES / "export_basic.json").read_text())
    request = data["requests"][0]
    request["response"] = [
        {"kind": "text", "value": "first"},
        {"kind": "markdownContent", "content": "second"},
        request["response"][0],
    ]

    parsed = parse_session_data(data).requests[0]

    assert [part["kind"] for part in parsed.response_parts] == ["text", "markdownContent", "toolInvocationSerialized"]
    assert parsed.response_parts[0]["value"] == "first"
    assert parsed.text == "do the thing"


def test_debug_response_parts_retain_text_reasoning_and_truncation(tmp_path: Path) -> None:
    directory = tmp_path / "sid"
    directory.mkdir()
    response = (
        json.dumps(
            [
                {
                    "role": "assistant",
                    "parts": [
                        {"type": "text", "text": "answer"},
                        {"type": "reasoning", "text": "partial thought"},
                    ],
                }
            ]
        )[:-1]
        + "[truncated]"
    )
    record = {
        "type": "agent_response",
        "sid": "sid",
        "spanId": "agent-msg-span-1",
        "attrs": {"response": response},
    }
    call = {"type": "llm_request", "sid": "sid", "spanId": "span-1", "ts": 1, "attrs": {}}
    (directory / "main.jsonl").write_text("\n".join(json.dumps(item) for item in [record, call]), encoding="utf-8")

    log = load_debug_log_dir(directory, "sid")

    assert log.responses[None]["span-1"].availability == "truncated"
    assert [(block.kind, block.text) for block in log.responses[None]["span-1"].blocks] == [
        ("message", "answer"),
        ("reasoning", "partial thought"),
    ]


def test_request_history_snapshots_are_retained_outside_conversation_messages(tmp_path: Path) -> None:
    directory = tmp_path / "sid"
    directory.mkdir()
    call = {
        "type": "llm_request",
        "sid": "sid",
        "spanId": "span-1",
        "ts": 1,
        "attrs": {"inputMessages": [{"role": "user", "parts": [{"type": "text", "text": "history"}]}]},
    }
    (directory / "main.jsonl").write_text(json.dumps(call), encoding="utf-8")

    log = load_debug_log_dir(directory, "sid")

    assert log.history[None]["span-1"][0].blocks[0].text == "history"


def test_debug_history_survives_missing_call_timestamp_without_fabricating_a_call(tmp_path: Path) -> None:
    directory = tmp_path / "sid"
    directory.mkdir()
    record = {
        "type": "llm_request",
        "sid": "sid",
        "spanId": "span-without-time",
        "attrs": {"inputMessages": [{"role": "user", "parts": [{"type": "text", "text": "recorded history"}]}]},
    }
    (directory / "main.jsonl").write_text(json.dumps(record), encoding="utf-8")

    log = load_debug_log_dir(directory, "sid")
    raw = parse_session_data(json.loads((_FIXTURES / "export_basic.json").read_text()))
    root = build_root(raw, None, log, 0.01)
    entry = next(
        transcript_entry
        for node in iter_nodes(root)
        for transcript_entry in node.transcript_entries
        if transcript_entry.channel == "request_history_snapshot"
    )

    assert log.malformed_lines == 1
    assert log.calls == {}
    assert entry.timestamp.value is None
    assert entry.source_request_id is None
    snapshot = entry.blocks[0].data
    assert isinstance(snapshot, list)
    assert snapshot[0]["blocks"][0]["text"] == "recorded history"


def test_debug_history_snapshot_preserves_block_encryption_and_message_truncation(tmp_path: Path) -> None:
    directory = tmp_path / "sid"
    directory.mkdir()
    raw = parse_session_data(json.loads((_FIXTURES / "export_basic.json").read_text()))
    message = {
        "role": "assistant",
        "parts": [{"type": "reasoning", "text": "unavailable reasoning", "encryptedContent": "synthetic cipher"}],
    }
    record = {
        "type": "llm_request",
        "sid": raw.session_id,
        "spanId": "span-1",
        "ts": 100,
        "attrs": {"inputMessages": json.dumps([message]) + "[truncated]"},
    }
    (directory / "main.jsonl").write_text(json.dumps(record), encoding="utf-8")

    root = build_root(raw, None, load_debug_log_dir(directory, raw.session_id or "sid"), 0.01)
    entry = next(
        transcript_entry
        for node in iter_nodes(root)
        for transcript_entry in node.transcript_entries
        if transcript_entry.channel == "request_history_snapshot"
    )
    snapshot = entry.blocks[0].data
    assert isinstance(snapshot, list)
    message_snapshot = snapshot[0]
    assert message_snapshot["availability"] == "truncated"
    block = message_snapshot["blocks"][0]
    assert block["availability"] == "encrypted"
    assert block["text"] is None
    assert block["data"] == {"type": "reasoning"}
    assert "synthetic cipher" not in repr(snapshot)


def test_unmatched_and_duplicate_debug_responses_and_histories_are_retained(tmp_path: Path) -> None:
    directory = tmp_path / "sid"
    directory.mkdir()
    messages = [
        {"role": "assistant", "parts": [{"type": "text", "text": "orphan response"}]},
        {"role": "assistant", "parts": [{"type": "text", "text": "duplicate response one"}]},
        {"role": "assistant", "parts": [{"type": "text", "text": "duplicate response two"}]},
    ]
    records = [
        {
            "type": "agent_response",
            "sid": "call_exec",
            "spanId": "agent-msg-orphan",
            "attrs": {"response": json.dumps([messages[0]])},
        },
        {
            "type": "llm_request",
            "sid": "call_exec",
            "spanId": "duplicate",
            "ts": 1,
            "attrs": {"inputMessages": [{"role": "user", "parts": [{"type": "text", "text": "history one"}]}]},
        },
        {
            "type": "llm_request",
            "sid": "call_exec",
            "spanId": "duplicate",
            "ts": 2,
            "attrs": {"inputMessages": [{"role": "user", "parts": [{"type": "text", "text": "history two"}]}]},
        },
        {
            "type": "agent_response",
            "sid": "call_exec",
            "spanId": "agent-msg-duplicate",
            "attrs": {"response": json.dumps([messages[1]])},
        },
        {
            "type": "agent_response",
            "sid": "call_exec",
            "spanId": "agent-msg-duplicate",
            "attrs": {"response": json.dumps([messages[2]])},
        },
    ]
    (directory / "child.jsonl").write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")
    raw = parse_session_data(json.loads((_FIXTURES / "export_basic.json").read_text()))
    log = load_debug_log_dir(directory, raw.session_id or "sid")

    root = build_root(raw, None, log, 0.01)
    entries = [
        entry
        for node in iter_nodes(root)
        for entry in node.transcript_entries
        if entry.source_stream_id.startswith("copilot-debug:")
    ]
    responses = [entry for entry in entries if entry.channel != "request_history_snapshot"]
    histories = [entry for entry in entries if entry.channel == "request_history_snapshot"]
    history_texts = []
    for entry in histories:
        snapshot = entry.blocks[0].data
        assert isinstance(snapshot, list) and snapshot
        first_message = snapshot[0]
        assert isinstance(first_message, dict)
        message_blocks = first_message["blocks"]
        assert isinstance(message_blocks, list) and message_blocks
        first_block = message_blocks[0]
        assert isinstance(first_block, dict)
        history_texts.append(first_block["text"])

    assert {entry.blocks[0].text for entry in responses} == {
        "orphan response",
        "duplicate response one",
        "duplicate response two",
    }
    assert set(history_texts) == {"history one", "history two"}
    assert len({entry.entry_id for entry in responses}) == 3
    assert all(entry.source_request_id is None for entry in responses + histories)
    assert all(entry.owner_id == "call_exec" for entry in responses + histories)
    assert [entry.source_position for entry in responses] == [0, 3, 4]
    assert [entry.native_ordinal for entry in responses] == [0, 3, 4]
    assert [entry.source_position for entry in histories] == [1, 2]
    assert [entry.native_ordinal for entry in histories] == [1, 2]


def test_debug_typed_parts_keep_structured_fields_next_to_text(tmp_path: Path) -> None:
    directory = tmp_path / "sid"
    directory.mkdir()
    response = json.dumps(
        [
            {
                "role": "assistant",
                "parts": [
                    {
                        "type": "text",
                        "text": "text body",
                        "content": {"structured": "still native"},
                        "metadata": {"source": "native"},
                    },
                    {
                        "type": "tool_call",
                        "id": "tool-1",
                        "text": "tool args",
                        "arguments": {"ciphertext": "plain argument"},
                    },
                    {
                        "type": "tool_call_response",
                        "id": "tool-1",
                        "text": "tool output",
                        "output": {"status": "ok"},
                        "custom": "kept",
                    },
                ],
            }
        ]
    )
    records = [
        {"type": "agent_response", "sid": "sid", "spanId": "agent-msg-span-1", "attrs": {"response": response}},
        {"type": "llm_request", "sid": "sid", "spanId": "span-1", "ts": 1, "attrs": {}},
    ]
    (directory / "main.jsonl").write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")

    blocks = load_debug_log_dir(directory, "sid").responses[None]["span-1"].blocks

    assert [(block.kind, block.text) for block in blocks] == [
        ("message", "text body"),
        ("tool_request", "tool args"),
        ("tool_result", "tool output"),
    ]
    assert blocks[0].data == {
        "type": "text",
        "content": {"structured": "still native"},
        "metadata": {"source": "native"},
    }
    assert blocks[1].data == {"type": "tool_call", "id": "tool-1", "arguments": {"ciphertext": "plain argument"}}
    assert blocks[2].data == {
        "type": "tool_call_response",
        "id": "tool-1",
        "output": {"status": "ok"},
        "custom": "kept",
    }


def test_debug_response_at_physical_position_zero_keeps_zero_in_entry_identity(tmp_path: Path) -> None:
    directory = tmp_path / "sid"
    directory.mkdir()
    response = json.dumps([{"role": "assistant", "parts": [{"type": "text", "text": "first line"}]}])
    records = [
        {"type": "agent_response", "sid": "sid", "spanId": "agent-msg-span-1", "attrs": {"response": response}},
        {"type": "llm_request", "sid": "sid", "spanId": "span-1", "ts": 1, "attrs": {}},
    ]
    (directory / "main.jsonl").write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")
    raw = parse_session_data(json.loads((_FIXTURES / "export_basic.json").read_text()))
    root = build_root(raw, None, load_debug_log_dir(directory, raw.session_id or "sid"), 0.01)
    entry = next(
        entry
        for node in iter_nodes(root)
        for entry in node.transcript_entries
        if entry.source_stream_id.startswith("copilot-debug:")
    )

    assert entry.source_position == 0
    assert entry.entry_id == transcript_entry_id(entry.source_stream_id, 0, native_id="agent-msg-span-1")
    assert entry.source_request_id == "span-1"


def test_missing_times_duplicate_native_ids_and_relocation_keep_physical_identity(tmp_path: Path) -> None:
    events = [
        {"id": "same", "type": "assistant.message", "data": {"messageId": "duplicate", "content": "one"}},
        {"id": "same", "type": "assistant.message", "data": {"messageId": "duplicate", "content": "two"}},
    ]
    first_path = tmp_path / "a" / "transcript.jsonl"
    second_path = tmp_path / "b" / "transcript.jsonl"
    first_path.parent.mkdir()
    second_path.parent.mkdir()
    encoded = "\n".join(json.dumps(event) for event in events)
    first_path.write_text(encoded, encoding="utf-8")
    second_path.write_text(encoded, encoding="utf-8")

    first = load_transcript(first_path)
    second = load_transcript(second_path)
    raw = parse_session_data(json.loads((_FIXTURES / "export_basic.json").read_text()))
    root = build_root(raw, first, None, 0.01)
    entries = [entry for node in iter_nodes(root) for entry in node.transcript_entries]
    messages = [
        entry
        for entry in entries
        if entry.kind == "assistant_message" and entry.source_stream_id.startswith("copilot-transcript:")
    ]

    assert [entry.source_position for entry in messages] == [0, 1]
    assert [entry.blocks[0].text for entry in messages] == ["one", "two"]
    assert all(entry.timestamp.provenance is Provenance.NOT_AVAILABLE for entry in messages)
    assert all(entry.source_request_id is None for entry in messages)
    assert messages[0].entry_id != messages[1].entry_id
    assert [entry.native_id for entry in messages] == ["duplicate", "duplicate"]
    assert messages[0].source_stream_id == messages[1].source_stream_id
    assert messages[0].source_stream_id == f"copilot-transcript:{raw.session_id}:transcript.jsonl"
    assert first_path.parent.as_posix() not in messages[0].entry_id
    assert second.native_records[0].source_position == 0


def test_blank_lines_keep_physical_source_position_separate_from_native_ordinal(tmp_path: Path) -> None:
    path = tmp_path / "transcript.jsonl"
    path.write_text(
        '\n{"type":"assistant.message","data":{"messageId":"m1","content":"one"}}\n\n'
        '{"type":"assistant.message","data":{"messageId":"m2","content":"two"}}\n',
        encoding="utf-8",
    )
    transcript = load_transcript(path)

    assert [(record.source_position, record.native_ordinal) for record in transcript.native_records] == [(1, 0), (3, 1)]


def test_explicit_owner_overrides_open_bracket_and_child_completion_stays_with_parent(tmp_path: Path) -> None:
    events = [
        _entry("session.start", 0, {"sessionId": "sid"}),
        _entry("tool.execution_start", 1, {"toolCallId": "call_lead", "toolName": "runSubagent", "arguments": {}}),
        _entry("assistant.message", 2, {"agentId": "call_lead", "messageId": "child", "content": "child text"}),
        _entry("tool.execution_complete", 3, {"toolCallId": "call_lead", "success": True, "output": {"ok": True}}),
    ]
    raw = parse_session_data(json.loads((_FIXTURES / "export_basic.json").read_text()))
    transcript_path = tmp_path / "sid.jsonl"
    transcript_path.write_text("\n".join(json.dumps(event) for event in events), encoding="utf-8")

    root = build_root(raw, load_transcript(transcript_path), None, 0.01)
    nodes = {node.node_id: node for node in iter_nodes(root)}
    transcript_entries = [
        entry
        for node in nodes.values()
        for entry in node.transcript_entries
        if entry.source_stream_id.startswith("copilot-transcript:")
    ]
    child_message = next(entry for entry in transcript_entries if entry.native_id == "child")
    delegation_result = next(
        entry for entry in transcript_entries if entry.kind == "tool_result" and entry.invocation_id == "call_lead"
    )

    assert child_message.owner_id == "call_lead"
    assert child_message.ownership_evidence == "explicit_owner"
    assert delegation_result.owner_id == "request_001"
    assert delegation_result.blocks[0].data == {"ok": True}


def test_parallel_sibling_agent_content_uses_explicit_owner_without_nested_guess(tmp_path: Path) -> None:
    events = [
        _entry("session.start", 0, {"sessionId": "sid"}),
        _entry("tool.execution_start", 1, {"toolCallId": "call_lead", "toolName": "runSubagent", "arguments": {}}),
        _entry(
            "tool.execution_start", 2, {"toolCallId": "call_exec", "toolName": "execution_subagent", "arguments": {}}
        ),
        _entry("assistant.message", 3, {"agentId": "call_exec", "messageId": "sibling", "content": "sibling"}),
        _entry("assistant.message", 4, {"messageId": "unknown", "content": "unowned while parallel"}),
    ]
    transcript_path = tmp_path / "sid.jsonl"
    transcript_path.write_text("\n".join(json.dumps(event) for event in events), encoding="utf-8")
    data = json.loads((_FIXTURES / "export_basic.json").read_text())
    next(part for part in data["requests"][0]["response"] if part.get("toolCallId") == "call_exec").pop(
        "subAgentInvocationId"
    )
    raw = parse_session_data(data)

    root = build_root(raw, load_transcript(transcript_path), None, 0.01)
    entries = [entry for node in iter_nodes(root) for entry in node.transcript_entries]
    sibling = next(entry for entry in entries if entry.native_id == "sibling")
    unknown = next(entry for entry in entries if entry.native_id == "unknown")

    assert sibling.owner_id == "call_exec"
    assert sibling.ownership_evidence == "explicit_owner"
    assert unknown.owner_id == "session"
    assert unknown.ownership_evidence == "ambiguous_parallel"


def test_remaining_parallel_agent_resumes_bracket_ownership_after_sibling_completion(tmp_path: Path) -> None:
    events = [
        _entry("session.start", 0, {"sessionId": "sid"}),
        _entry("tool.execution_start", 1, {"toolCallId": "call_lead", "toolName": "runSubagent", "arguments": {}}),
        _entry(
            "tool.execution_start", 2, {"toolCallId": "call_exec", "toolName": "execution_subagent", "arguments": {}}
        ),
        _entry("tool.execution_complete", 3, {"toolCallId": "call_exec", "success": True, "output": "done"}),
        _entry("assistant.message", 4, {"messageId": "remaining", "content": "remaining sibling"}),
    ]
    export = json.loads((_FIXTURES / "export_basic.json").read_text())
    next(part for part in export["requests"][0]["response"] if part.get("toolCallId") == "call_exec").pop(
        "subAgentInvocationId"
    )

    root = _tree(tmp_path, events, export)
    message = next(
        entry
        for node in iter_nodes(root)
        for entry in node.transcript_entries
        if entry.source_stream_id.startswith("copilot-transcript:") and entry.native_id == "remaining"
    )

    assert message.owner_id == "call_lead"
    assert message.ownership_evidence == "bracket"


def test_export_only_tree_has_recorded_content_and_missing_transcript_coverage() -> None:
    data = json.loads((_FIXTURES / "export_basic.json").read_text())
    data["requests"][0]["response"].insert(0, {"kind": "markdownContent", "content": "export answer"})
    data["requests"][0]["response"][2]["toolSpecificData"] = {
        "prompt": "child prompt",
        "result": "child result",
    }
    raw = parse_session_data(data)
    root = build_root(raw, None, None, 0.01)
    nodes = {node.node_id: node for node in iter_nodes(root)}
    turn = nodes[raw.requests[0].request_id]
    content = [entry for entry in turn.transcript_entries if entry.source_stream_id.startswith("copilot-export:")]
    child = nodes["call_lead"]

    assert root.transcript_coverage.source_present is True
    assert root.transcript_coverage.reasons == ["transcript_file_missing"]
    assert any(entry.blocks[0].text == "export answer" for entry in content)
    assert {
        entry.blocks[0].text
        for entry in child.transcript_entries
        if entry.source_stream_id.startswith("copilot-export:")
    } >= {"child prompt", "child result"}


def test_export_entries_keep_request_and_response_order_without_synthetic_position_offsets() -> None:
    data = json.loads((_FIXTURES / "export_basic.json").read_text())
    first = data["requests"][0]
    first["response"] = [
        {"kind": "text", "text": "first-a"},
        {"kind": "text", "text": "first-b"},
    ]
    second = json.loads(json.dumps(first))
    second["requestId"] = "request_002"
    second["timestamp"] += 60_000
    second["message"]["text"] = "second prompt"
    second["message"]["parts"] = [{"kind": "text", "text": "second prompt"}]
    second["response"] = [
        {"kind": "text", "text": "second-a"},
        {"kind": "text", "text": "second-b"},
    ]
    data["requests"] = [first, second]
    raw = parse_session_data(data)

    root = build_root(raw, None, None, 0.01)
    entries = [
        entry
        for node in iter_nodes(root)
        for entry in node.transcript_entries
        if entry.source_stream_id.startswith("copilot-export:")
    ]
    ordered = sorted(entries, key=lambda entry: (entry.source_position, entry.block_position))

    assert [entry.source_position for entry in ordered] == [0, 0, 0, 1, 1, 1]
    assert [entry.blocks[0].text for entry in ordered] == [
        "do the thing",
        "first-a",
        "first-b",
        "second prompt",
        "second-a",
        "second-b",
    ]
    assert len({entry.entry_id for entry in entries}) == len(entries)


def test_equal_prompt_text_does_not_assign_transcript_turn_ownership(tmp_path: Path) -> None:
    events = [
        _entry("session.start", 0, {"sessionId": "sid"}),
        _entry("user.message", 1, {"content": "do the thing"}),
        _entry("assistant.message", 2, {"messageId": "answer", "content": "answer"}),
    ]

    root = _tree(tmp_path, events)
    answer = next(
        entry
        for node in iter_nodes(root)
        for entry in node.transcript_entries
        if entry.source_stream_id.startswith("copilot-transcript:") and entry.native_id == "answer"
    )

    assert answer.owner_id == "session"
    assert answer.ownership_evidence == "root"


def test_encrypted_reasoning_payload_is_removed_from_transcript_export_and_debug(tmp_path: Path) -> None:
    part = {"type": "encrypted_reasoning", "encryptedContent": "secret-one", "encrypted_content": "secret-two"}
    root = _tree(
        tmp_path,
        [
            _entry("session.start", 0, {"sessionId": "sid"}),
            _entry("assistant.message", 1, {"messageId": "reason", "content": [part]}),
        ],
    )
    transcript_block = next(
        block
        for node in iter_nodes(root)
        for entry in node.transcript_entries
        if entry.source_stream_id.startswith("copilot-transcript:") and entry.native_id == "reason"
        for block in entry.blocks
    )
    export = json.loads((_FIXTURES / "export_basic.json").read_text())
    export["requests"][0]["response"] = [{"kind": "reasoning", **part}]
    export_root = build_root(parse_session_data(export), None, None, 0.01)
    export_block = next(
        block
        for entry in export_root.children[0].transcript_entries
        if entry.source_stream_id.startswith("copilot-export:") and entry.blocks[0].native_type == "reasoning"
        for block in entry.blocks
    )
    directory = tmp_path / "debug"
    directory.mkdir()
    response = json.dumps([{"role": "assistant", "parts": [{**part, "type": "reasoning"}]}])
    debug_records = [
        {"type": "agent_response", "sid": "sid", "spanId": "agent-msg-span", "attrs": {"response": response}},
        {"type": "llm_request", "sid": "sid", "spanId": "span", "ts": 1, "attrs": {}},
    ]
    (directory / "main.jsonl").write_text("\n".join(json.dumps(record) for record in debug_records), encoding="utf-8")
    debug_block = load_debug_log_dir(directory, "sid").responses[None]["span"].blocks[0]

    for block in (transcript_block, export_block, debug_block):
        assert block.kind == "reasoning"
        assert block.availability == "encrypted"
        assert "secret-one" not in repr(block)
        assert "secret-two" not in repr(block)


def test_conflicting_invocation_start_remains_on_root_instead_of_parent_node(tmp_path: Path) -> None:
    events = [
        _entry("session.start", 0, {"sessionId": "sid"}),
        _entry(
            "tool.execution_start",
            1,
            {"toolCallId": "call_lead", "toolName": "runSubagent", "arguments": {}, "agentId": "call_exec"},
        ),
    ]

    root = _tree(tmp_path, events)
    start = next(
        entry
        for node in iter_nodes(root)
        for entry in node.transcript_entries
        if entry.source_stream_id.startswith("copilot-transcript:") and entry.kind == "tool_request"
    )

    assert start.owner_id == "session"
    assert start.logical_stream_id == "sid"
    assert start.ownership_evidence == "ambiguous_conflicting_owner"


def test_ambiguous_delegation_start_does_not_propagate_child_ownership(tmp_path: Path) -> None:
    events = [
        _entry("session.start", 0, {"sessionId": "sid"}),
        _entry(
            "tool.execution_start",
            1,
            {"toolCallId": "call_lead", "toolName": "runSubagent", "arguments": {}, "agentId": "call_exec"},
        ),
        _entry("assistant.message", 2, {"messageId": "linked", "content": "parent is ambiguous"}, parentId="event-1"),
        _entry("assistant.message", 3, {"messageId": "unlinked", "content": "stack must stay root"}),
    ]

    root = _tree(tmp_path, events)
    entries = [entry for node in iter_nodes(root) for entry in node.transcript_entries]
    linked = next(entry for entry in entries if entry.native_id == "linked")
    unlinked = next(entry for entry in entries if entry.native_id == "unlinked")

    assert linked.owner_id == "session"
    assert linked.ownership_evidence == "ambiguous"
    assert unlinked.owner_id == "session"
    assert unlinked.ownership_evidence == "root"


def test_conflicting_completion_owner_does_not_override_source_evidence(tmp_path: Path) -> None:
    events = [
        _entry("session.start", 0, {"sessionId": "sid"}),
        _entry(
            "tool.execution_start",
            1,
            {"toolCallId": "call_read_child", "toolName": "read_file", "arguments": {}},
        ),
        _entry(
            "tool.execution_complete",
            2,
            {"toolCallId": "call_read_child", "success": True, "output": "done", "agentId": "call_lead"},
        ),
    ]

    root = _tree(tmp_path, events)
    completion = next(
        entry
        for node in iter_nodes(root)
        for entry in node.transcript_entries
        if entry.source_stream_id.startswith("copilot-transcript:") and entry.kind == "tool_result"
    )

    assert completion.owner_id == "session"
    assert completion.logical_stream_id == "sid"
    assert completion.ownership_evidence == "ambiguous_conflicting_owner"


def test_duplicate_event_ids_cannot_resolve_parent_ownership(tmp_path: Path) -> None:
    events = [
        _entry("session.start", 0, {"sessionId": "sid"}),
        _entry("tool.execution_start", 1, {"toolCallId": "call_lead", "toolName": "runSubagent", "arguments": {}}),
        _entry("assistant.message", 2, {"messageId": "other", "content": "root"}),
        _entry("assistant.message", 3, {"messageId": "child?", "content": "ambiguous"}, parentId="event-1"),
    ]
    events[2]["id"] = "event-1"

    root = _tree(tmp_path, events)
    child = next(
        entry
        for node in iter_nodes(root)
        for entry in node.transcript_entries
        if entry.source_stream_id.startswith("copilot-transcript:") and entry.native_id == "child?"
    )

    assert child.owner_id == "session"
    assert child.ownership_evidence == "ambiguous"


def test_export_reasoning_empty_and_text_payload_availability_are_exact() -> None:
    data = json.loads((_FIXTURES / "export_basic.json").read_text())
    data["requests"][0]["response"] = [
        {"kind": "reasoning", "text": ""},
        {"kind": "text"},
    ]
    raw = parse_session_data(data)
    root = build_root(raw, None, None, 0.01)
    entries = [
        entry for entry in root.children[0].transcript_entries if entry.source_stream_id.startswith("copilot-export:")
    ]
    reasoning, text = entries[1:]

    assert reasoning.blocks[0].kind == "reasoning"
    assert reasoning.blocks[0].text == ""
    assert reasoning.blocks[0].availability == "recorded"
    assert text.blocks[0].kind == "message"
    assert text.blocks[0].availability == "unavailable"


def test_export_prompt_keeps_empty_and_missing_text_availability_distinct() -> None:
    data = json.loads((_FIXTURES / "export_basic.json").read_text())
    data["requests"][0]["message"]["text"] = ""
    data["requests"][0]["message"]["parts"] = [{"kind": "text", "text": ""}]
    empty_raw = parse_session_data(data)
    missing = json.loads((_FIXTURES / "export_basic.json").read_text())
    missing["requests"][0]["message"] = {}
    missing_raw = parse_session_data(missing)

    empty_entry = build_root(empty_raw, None, None, 0.01).children[0].transcript_entries[0]
    missing_entry = build_root(missing_raw, None, None, 0.01).children[0].transcript_entries[0]

    assert empty_entry.blocks[0].text == ""
    assert empty_entry.blocks[0].availability == "recorded"
    assert missing_entry.blocks[0].text is None
    assert missing_entry.blocks[0].availability == "unavailable"


def test_empty_export_file_is_still_a_present_metadata_source() -> None:
    raw = parse_session_data({"requests": []})

    root = build_root(raw, None, None, 0.01)

    assert root.transcript_coverage.source_present is True
    assert "export" in root.transcript_coverage.categories


def test_encrypted_debug_reasoning_keeps_metadata_without_payload(tmp_path: Path) -> None:
    directory = tmp_path / "sid"
    directory.mkdir()
    response = json.dumps(
        [{"role": "assistant", "parts": [{"type": "encrypted_reasoning", "encryptedContent": "cipher"}]}]
    )
    records = [
        {"type": "agent_response", "sid": "sid", "spanId": "agent-msg-span-1", "attrs": {"response": response}},
        {"type": "llm_request", "sid": "sid", "spanId": "span-1", "ts": 1, "attrs": {}},
    ]
    (directory / "main.jsonl").write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")

    response_message = load_debug_log_dir(directory, "sid").responses[None]["span-1"]

    assert response_message.blocks[0].kind == "reasoning"
    assert response_message.blocks[0].availability == "encrypted"
    assert response_message.blocks[0].text is None
    assert response_message.blocks[0].data == {"type": "encrypted_reasoning"}


def test_debug_typed_text_distinguishes_missing_from_recorded_empty(tmp_path: Path) -> None:
    directory = tmp_path / "sid"
    directory.mkdir()
    response = json.dumps(
        [
            {
                "role": "assistant",
                "parts": [{"type": "text", "text": ""}, {"type": "text"}],
            }
        ]
    )
    records = [
        {"type": "agent_response", "sid": "sid", "spanId": "agent-msg-span-1", "attrs": {"response": response}},
        {"type": "llm_request", "sid": "sid", "spanId": "span-1", "ts": 1, "attrs": {}},
    ]
    (directory / "main.jsonl").write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")

    blocks = load_debug_log_dir(directory, "sid").responses[None]["span-1"].blocks

    assert blocks[0].text == ""
    assert blocks[0].availability == "recorded"
    assert blocks[1].text is None
    assert blocks[1].availability == "unavailable"
