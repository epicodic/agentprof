# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

"""Behavior tests for retaining source Codex transcript records."""

import json
from collections.abc import Iterable, Mapping
from pathlib import Path

from agentprof.adapters.codex.adapter import _merge_main_rollouts
from agentprof.adapters.codex.rollout import load_rollout
from agentprof.adapters.codex.tree import build_root
from agentprof.analysis.session_index import SessionIndex
from agentprof.model import Node, NodeKind, TranscriptEntry, iter_nodes
from agentprof.pricing import PriceTable
from agentprof.server.transcript_schema import transcript_detail_out


def _write_rollout(path: Path, records: Iterable[Mapping[str, object]]) -> None:
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n", encoding="utf-8")


def _entries(root: Node) -> list[TranscriptEntry]:
    return [entry for node in iter_nodes(root) for entry in node.transcript_entries]


def test_retains_all_message_and_reasoning_content_in_physical_order(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    _write_rollout(
        path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}},
            {
                "type": "response_item",
                "ordinal": 50,
                "payload": {
                    "type": "message",
                    "id": "same",
                    "role": "user",
                    "content": [{"type": "input_text", "text": ""}],
                },
            },
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn"}},
            {
                "type": "response_item",
                "ordinal": 1,
                "payload": {
                    "type": "message",
                    "id": "same",
                    "role": "assistant",
                    "channel": "commentary",
                    "content": [{"type": "output_text", "text": "thinking aloud"}],
                },
            },
            {
                "type": "response_item",
                "ordinal": 0,
                "payload": {
                    "type": "reasoning",
                    "id": "reasoning-id",
                    "summary": "A native summary",
                    "text": "top level reasoning text",
                    "content": [{"type": "reasoning_text", "text": "plain reasoning"}],
                    "encrypted_content": "secret ciphertext",
                },
            },
            {
                "type": "response_item",
                "ordinal": 0,
                "payload": {
                    "type": "message",
                    "id": "same",
                    "role": "assistant",
                    "channel": "final",
                    "content": [{"type": "output_text", "text": "done"}],
                },
            },
            {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "turn"}},
            {
                "type": "response_item",
                "payload": {"type": "agent_message", "id": "legacy", "content": "legacy body"},
            },
        ],
    )

    rollout = load_rollout(path)
    root = build_root(rollout, [], PriceTable.load(), "session")
    entries = sorted(_entries(root), key=lambda entry: (entry.source_position, entry.block_position))

    assert [(entry.kind, entry.role, entry.channel) for entry in entries] == [
        ("user_message", "user", None),
        ("assistant_message", "assistant", "commentary"),
        ("reasoning", None, None),
        ("reasoning", None, None),
        ("reasoning", None, None),
        ("reasoning", None, None),
        ("assistant_message", "assistant", "final"),
        ("assistant_message", None, None),
    ]
    assert entries[0].blocks[0].text == ""
    assert entries[0].blocks[0].availability == "recorded"
    assert [entry.source_position for entry in entries] == [1, 3, 4, 4, 4, 4, 5, 7]
    assert [entry.native_ordinal for entry in entries] == [50, 1, 0, 0, 0, 0, 0, None]
    reasoning = entries[2:6]
    assert [(entry.blocks[0].native_type, entry.blocks[0].text) for entry in reasoning] == [
        ("reasoning_text", "plain reasoning"),
        ("text", "top level reasoning text"),
        ("summary_text", "A native summary"),
        ("encrypted_content", None),
    ]
    assert reasoning[3].blocks[0].availability == "encrypted"
    assert "secret ciphertext" not in repr(reasoning)
    assert len({entry.entry_id for entry in entries}) == len(entries)


def test_fixture_agent_message_exposes_recorded_participants() -> None:
    fixture = Path(__file__).parent / "fixtures/sessions/2026/09/26/rollout-2026-09-26T10-00-10-agent.jsonl"
    rollout = load_rollout(fixture)
    root = build_root(rollout, [], PriceTable.load(), "session")

    entry = next(entry for entry in _entries(root) if entry.blocks[0].text == "Documentation reviewed.")

    assert entry.role is None
    assert (entry.sender, entry.recipient) == ("/root/task", "/root")
    assert entry.blocks[0].text == "Documentation reviewed."
    assert entry.blocks[0].data == {"author": "/root/task", "recipient": "/root"}


def test_empty_agent_message_participant_fields_remain_unresolved(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    _write_rollout(
        path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}},
            {
                "type": "response_item",
                "payload": {"type": "agent_message", "author": "", "recipient": "", "content": "message"},
            },
        ],
    )
    root = build_root(load_rollout(path), [], PriceTable.load(), "session")
    entry = _entries(root)[0]

    assert (entry.sender, entry.recipient) == (None, None)


def test_agent_message_participant_metadata_does_not_replace_structured_content(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    _write_rollout(
        path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}},
            {
                "type": "response_item",
                "payload": {
                    "type": "agent_message",
                    "author": "/root/task",
                    "recipient": "/root",
                    "content": [{"type": "future_part", "payload": {"k": 1}}],
                },
            },
        ],
    )
    root = build_root(load_rollout(path), [], PriceTable.load(), "session")
    entry = _entries(root)[0]
    detail = transcript_detail_out(SessionIndex(root), entry)

    assert (detail.sender, detail.recipient) == ("/root/task", "/root")
    assert detail.blocks[0].availability == "unsupported"
    assert detail.blocks[0].data == {"type": "future_part", "payload": {"k": 1}}


def test_continuation_streams_keep_distinct_stable_physical_identities(tmp_path: Path) -> None:
    first = tmp_path / "first.jsonl"
    second = tmp_path / "second.jsonl"
    item = {
        "type": "response_item",
        "ordinal": 4,
        "payload": {"type": "message", "id": "shared", "role": "assistant", "channel": "final", "content": "same body"},
    }
    _write_rollout(first, [{"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}}, item])
    _write_rollout(
        second,
        [{"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}}, item],
    )

    merged = _merge_main_rollouts([load_rollout(first), load_rollout(second)])
    root = build_root(merged, [], PriceTable.load(), "session")
    entries = _entries(root)

    assert len(entries) == 2
    assert entries[0].blocks[0].text == entries[1].blocks[0].text == "same body"
    assert entries[0].source_stream_id != entries[1].source_stream_id
    assert entries[0].logical_stream_id == entries[1].logical_stream_id == "thread"
    assert entries[0].entry_id != entries[1].entry_id


def test_tool_content_keeps_empty_unavailable_structured_and_orphan_outputs(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    _write_rollout(
        path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn"}},
            {
                "type": "response_item",
                "ordinal": 1,
                "payload": {
                    "type": "function_call",
                    "call_id": "call",
                    "name": "exec_command",
                    "arguments": {"cmd": "pwd"},
                },
            },
            {
                "type": "response_item",
                "ordinal": 2,
                "payload": {"type": "function_call_output", "call_id": "call", "output": ""},
            },
            {
                "type": "response_item",
                "ordinal": 3,
                "payload": {"type": "function_call_output", "call_id": "missing", "output": None},
            },
            {
                "type": "response_item",
                "ordinal": 4,
                "payload": {"type": "custom_tool_call", "call_id": "custom", "name": "lookup", "input": {"term": "x"}},
            },
            {
                "type": "response_item",
                "ordinal": 5,
                "payload": {"type": "custom_tool_call_output", "call_id": "orphan", "output": "orphan body"},
            },
        ],
    )

    rollout = load_rollout(path)
    root = build_root(rollout, [], PriceTable.load(), "session")
    turn = root.children[0]
    entries = sorted(turn.transcript_entries, key=lambda entry: entry.source_position)

    assert len(turn.children) == 2
    assert entries[0].kind == "tool_request"
    assert entries[0].blocks[0].data == {"name": "exec_command", "arguments": {"cmd": "pwd"}}
    assert entries[1].kind == "tool_result"
    assert entries[1].blocks[0].text == ""
    assert entries[1].blocks[0].availability == "recorded"
    assert entries[2].kind == "tool_result"
    assert entries[2].blocks[0].availability == "unavailable"
    assert entries[3].blocks[0].data == {"name": "lookup", "arguments": {"term": "x"}}
    assert entries[4].kind == "tool_result"
    assert entries[4].blocks[0].text == "orphan body"
    assert entries[4].subject_node_id is None
    assert turn.transcript_coverage.source_present is True
    assert "unavailable_content" in turn.transcript_coverage.reasons


def test_duplicate_invocation_ids_keep_content_but_leave_subjects_unresolved(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    _write_rollout(
        path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn"}},
            {
                "type": "response_item",
                "ordinal": 1,
                "payload": {"type": "function_call", "call_id": "duplicate", "name": "exec_command", "arguments": "{}"},
            },
            {
                "type": "response_item",
                "ordinal": 2,
                "payload": {"type": "function_call_output", "call_id": "duplicate", "output": "first result"},
            },
            {
                "type": "response_item",
                "ordinal": 3,
                "payload": {"type": "function_call", "call_id": "duplicate", "name": "exec_command", "arguments": "{}"},
            },
            {
                "type": "response_item",
                "ordinal": 4,
                "payload": {"type": "function_call_output", "call_id": "duplicate", "output": "second result"},
            },
        ],
    )

    root = build_root(load_rollout(path), [], PriceTable.load(), "session")
    turn = root.children[0]
    requests = [entry for entry in turn.transcript_entries if entry.kind == "tool_request"]
    results = [entry for entry in turn.transcript_entries if entry.kind == "tool_result"]

    assert len(turn.children) == 2
    assert [tool.result for tool in turn.children] == ["first result", "second result"]
    assert len(turn.execution_events) == 4
    assert [entry.invocation_id for entry in requests + results] == ["duplicate"] * 4
    assert all(entry.subject_node_id is None for entry in requests + results)


def test_tool_payload_fields_named_like_encryption_are_preserved(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    arguments = {"encrypted_content": "argument value", "nested": {"ciphertext": "argument ciphertext"}}
    output = {"encrypted_payload": "output value", "nested": {"encrypted_content": "output ciphertext"}}
    _write_rollout(
        path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn"}},
            {
                "type": "response_item",
                "payload": {"type": "function_call", "call_id": "payload", "name": "tool", "arguments": arguments},
            },
            {
                "type": "response_item",
                "payload": {"type": "function_call_output", "call_id": "payload", "output": output},
            },
        ],
    )

    root = build_root(load_rollout(path), [], PriceTable.load(), "session")
    entries = _entries(root)
    requests = [entry for entry in entries if entry.kind == "tool_request"]
    results = [entry for entry in entries if entry.kind == "tool_result"]

    assert requests[0].blocks[0].data == {"name": "tool", "arguments": arguments}
    assert results[0].blocks[0].data == output


def test_only_exact_native_event_identity_creates_references(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    _write_rollout(
        path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}},
            {
                "type": "response_item",
                "ordinal": 0,
                "payload": {"type": "message", "id": "pre-user", "role": "user", "content": "prelude"},
            },
            {"type": "event_msg", "ordinal": 1, "payload": {"type": "task_started", "turn_id": "turn"}},
            {
                "type": "response_item",
                "ordinal": 2,
                "payload": {"type": "message", "id": "active-user", "role": "user", "content": "prompt"},
            },
            {
                "type": "token_usage_record",
                "ordinal": 3,
                "timestamp": "2026-09-26T10:00:00.000Z",
                "payload": {
                    "turn_id": "turn",
                    "response_id": "request-1",
                    "usage": {"input_tokens": 5, "output_tokens": 2},
                },
            },
            {
                "type": "response_item",
                "ordinal": 4,
                "timestamp": "2026-09-26T10:00:00.000Z",
                "payload": {
                    "type": "message",
                    "id": "request-1",
                    "role": "assistant",
                    "channel": "commentary",
                    "content": "same time",
                },
            },
            {
                "type": "response_item",
                "ordinal": 5,
                "payload": {"type": "message", "id": "same", "role": "assistant", "content": "duplicate"},
            },
            {
                "type": "response_item",
                "ordinal": 6,
                "payload": {
                    "type": "message",
                    "id": "same",
                    "response_id": "explicit-response",
                    "role": "assistant",
                    "content": "duplicate",
                },
            },
            {
                "type": "response_item",
                "ordinal": 7,
                "payload": {
                    "type": "message",
                    "id": "system-note",
                    "role": "system",
                    "content": [{"type": "image", "url": "image-ref"}],
                },
            },
        ],
    )
    with path.open("a", encoding="utf-8") as output:
        output.write("\nnot json\n")

    rollout = load_rollout(path)
    root = build_root(rollout, [], PriceTable.load(), "session")
    entries = sorted(_entries(root), key=lambda entry: (entry.source_position, entry.block_position))
    turn = root.children[0]
    prelude, active_user, timestamp_only, duplicate_one, duplicate_two, system = entries

    assert prelude.owner_id == root.node_id
    assert prelude.ownership_evidence == "unassigned_turn"
    assert active_user.event_id == "user-input:active-user"
    assert timestamp_only.source_request_id is None
    assert turn.llm_calls[0].source_request_id == "request-1"
    assert timestamp_only.source_request_id != turn.llm_calls[0].source_request_id
    assert duplicate_two.source_request_id == "explicit-response"
    assert duplicate_one.entry_id != duplicate_two.entry_id
    assert system.kind == "message"
    assert system.source_position == 8
    assert system.blocks[0].availability == "unsupported"
    assert rollout.malformed_lines == 1
    assert "malformed_lines_skipped" in root.transcript_coverage.reasons
    assert "missing_timestamps" in turn.transcript_coverage.reasons


def test_records_empty_content_separately_from_absent_and_null_content(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    _write_rollout(
        path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": ""}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant"}},
            {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": None}},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": None}],
                },
            },
        ],
    )

    root = build_root(load_rollout(path), [], PriceTable.load(), "session")
    entries = sorted(root.transcript_entries, key=lambda entry: entry.source_position)

    assert entries[0].blocks[0].text == ""
    assert entries[0].blocks[0].availability == "recorded"
    assert entries[1].blocks[0].text is None
    assert entries[1].blocks[0].availability == "unavailable"
    assert entries[2].blocks[0].text is None
    assert entries[2].blocks[0].availability == "unavailable"
    assert entries[3].blocks[0].availability == "unavailable"


def test_only_latest_explicit_terminal_item_fills_an_empty_turn_result(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    _write_rollout(
        path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn"}},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "channel": "commentary",
                    "content": [{"type": "output_text", "text": "commentary"}],
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "channel": "final",
                    "content": [{"type": "output_text", "text": "old final"}],
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "channel": "final",
                    "content": [
                        {"type": "output_text", "text": "new first"},
                        {"type": "output_text", "text": "new second"},
                    ],
                },
            },
        ],
    )

    root = build_root(load_rollout(path), [], PriceTable.load(), "session")

    assert root.children[0].result == "new first\nnew second"


def test_later_recorded_empty_final_supersedes_earlier_final_text(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    _write_rollout(
        path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn"}},
            {
                "type": "response_item",
                "payload": {"type": "message", "role": "assistant", "channel": "final", "content": "earlier"},
            },
            {
                "type": "response_item",
                "payload": {"type": "message", "role": "assistant", "channel": "final", "content": ""},
            },
        ],
    )

    root = build_root(load_rollout(path), [], PriceTable.load(), "session")

    assert root.children[0].result == ""


def test_source_presence_covers_readable_metadata_only_main_and_child(tmp_path: Path) -> None:
    main_path = tmp_path / "main.jsonl"
    child_path = tmp_path / "child.jsonl"
    _write_rollout(
        main_path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "main"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn"}},
        ],
    )
    _write_rollout(
        child_path,
        [
            {
                "type": "session_meta",
                "payload": {"session_id": "session", "id": "child", "parent_thread_id": "main"},
            }
        ],
    )

    root = build_root(load_rollout(main_path), [load_rollout(child_path)], PriceTable.load(), "session")
    child = next(node for node in iter_nodes(root) if node.kind is NodeKind.AGENT)

    assert root.transcript_coverage.source_present is True
    assert root.children[0].transcript_coverage.source_present is True
    assert child.transcript_coverage.source_present is True


def test_missing_rollout_does_not_claim_transcript_source_presence(tmp_path: Path) -> None:
    root = build_root(load_rollout(tmp_path / "missing.jsonl"), [], PriceTable.load(), "session")

    assert root.transcript_coverage.source_present is False


def test_explicit_turn_id_owns_content_even_after_completion_or_during_another_turn(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    _write_rollout(
        path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "first"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "second"}},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "id": "conflict",
                    "turn_id": "first",
                    "role": "assistant",
                    "content": "first owner",
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "id": "unknown",
                    "turn_id": "missing",
                    "role": "assistant",
                    "content": "unresolved owner",
                },
            },
            {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "second"}},
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "id": "post-task",
                    "turn_id": "first",
                    "role": "assistant",
                    "content": "post task",
                },
            },
        ],
    )

    root = build_root(load_rollout(path), [], PriceTable.load(), "session")
    first, second = root.children
    conflict = next(entry for entry in first.transcript_entries if entry.native_id == "conflict")
    unresolved = next(entry for entry in root.transcript_entries if entry.native_id == "unknown")
    post_task = next(entry for entry in first.transcript_entries if entry.native_id == "post-task")

    assert conflict.owner_id == first.node_id
    assert conflict.ownership_evidence == "explicit_turn:first"
    assert unresolved.owner_id == root.node_id
    assert unresolved.ownership_evidence == "unresolved_turn:missing"
    assert post_task.owner_id == first.node_id
    assert post_task.ownership_evidence == "explicit_turn:first"
    assert [turn.node_id for turn in root.children] == ["first", "second"]


def test_compaction_retains_plaintext_metadata_without_encrypted_content(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    _write_rollout(
        path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn"}},
            {
                "type": "response_item",
                "ordinal": 2,
                "timestamp": "2026-09-26T10:00:00.000Z",
                "payload": {
                    "type": "compaction",
                    "id": "compact-id",
                    "summary": [{"type": "summary_text", "text": "Older context summarized"}],
                    "metadata": {"kept": True},
                    "encrypted_content": "secret compaction payload",
                },
            },
        ],
    )

    root = build_root(load_rollout(path), [], PriceTable.load(), "session")
    entries = root.children[0].transcript_entries
    entry = entries[0]

    assert entry.kind == "compaction"
    assert entry.event_id == "compact-id"
    assert entry.blocks[0].native_type == "summary_text"
    assert entry.blocks[0].text == "Older context summarized"
    assert any(entry.blocks[0].data == {"metadata": {"kept": True}} for entry in entries)
    assert "secret compaction payload" not in repr(entries)
    assert "encrypted_content" in root.children[0].transcript_coverage.reasons


def test_child_plaintext_prompt_remains_native_content_under_child_owner(tmp_path: Path) -> None:
    parent_path = tmp_path / "parent.jsonl"
    child_path = tmp_path / "child.jsonl"
    _write_rollout(
        parent_path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "parent-thread"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "parent-turn"}},
            {
                "type": "response_item",
                "ordinal": 1,
                "payload": {
                    "type": "function_call",
                    "call_id": "delegate",
                    "name": "spawn_agent",
                    "arguments": json.dumps({"nickname": "Worker", "message": "gAAAAencrypted"}),
                },
            },
            {
                "type": "response_item",
                "ordinal": 2,
                "payload": {"type": "function_call_output", "call_id": "delegate", "output": "started"},
            },
        ],
    )
    _write_rollout(
        child_path,
        [
            {
                "type": "session_meta",
                "payload": {
                    "session_id": "session",
                    "id": "worker-thread",
                    "parent_thread_id": "parent-thread",
                    "agent_nickname": "Worker",
                },
            },
            {
                "type": "response_item",
                "ordinal": 0,
                "payload": {"type": "message", "id": "child-prompt", "role": "user", "content": "plain child prompt"},
            },
        ],
    )

    root = build_root(load_rollout(parent_path), [load_rollout(child_path)], PriceTable.load(), "session")
    turn = root.children[0]
    agent = next(node for node in iter_nodes(root) if node.kind is NodeKind.AGENT)
    delegation = next(entry for entry in turn.transcript_entries if entry.kind == "delegation")
    delegated_result = next(entry for entry in turn.transcript_entries if entry.kind == "tool_result")
    child_prompt = agent.transcript_entries[0]

    assert delegation.owner_id == turn.node_id
    assert delegation.subject_node_id == agent.node_id
    assert delegated_result.subject_node_id == agent.node_id
    assert child_prompt.owner_id == agent.node_id
    assert child_prompt.blocks[0].text == "plain child prompt"
    assert agent.prompt == "Handover unavailable: Codex stored it encrypted."


def test_physical_stream_identity_is_stable_after_relocation(tmp_path: Path) -> None:
    relative = Path("sessions/2026/09/26/rollout-native.jsonl")
    payload = json.dumps(
        {
            "type": "response_item",
            "ordinal": 0,
            "payload": {"type": "message", "id": "m", "role": "assistant", "content": "same"},
        }
    )
    first = tmp_path / "origin" / relative
    second = tmp_path / "relocated" / relative
    first.parent.mkdir(parents=True)
    second.parent.mkdir(parents=True)
    first.write_text(payload + "\n", encoding="utf-8")
    second.write_text(payload + "\n", encoding="utf-8")

    left = _entries(build_root(load_rollout(first), [], PriceTable.load(), "first"))[0]
    right = _entries(build_root(load_rollout(second), [], PriceTable.load(), "second"))[0]
    with first.open("a", encoding="utf-8") as output:
        output.write(
            json.dumps(
                {
                    "type": "response_item",
                    "ordinal": 0,
                    "payload": {"type": "message", "role": "assistant", "content": "appended"},
                }
            )
            + "\n"
        )
    after_append = _entries(build_root(load_rollout(first), [], PriceTable.load(), "first"))[0]

    assert left.source_stream_id == right.source_stream_id
    assert left.entry_id == right.entry_id
    assert left.entry_id == after_append.entry_id


def test_retains_content_bearing_event_messages_without_creating_accounting_nodes(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    _write_rollout(
        path,
        [
            {"type": "session_meta", "payload": {"session_id": "session", "id": "thread"}},
            {
                "type": "event_msg",
                "ordinal": 8,
                "payload": {"type": "user_message", "id": "event-user", "message": "recorded prompt"},
            },
            {"type": "event_msg", "ordinal": 8, "payload": {"type": "agent_reasoning", "text": "recorded thought"}},
        ],
    )

    root = build_root(load_rollout(path), [], PriceTable.load(), "session")
    entries = sorted(root.transcript_entries, key=lambda entry: entry.source_position)

    assert [entry.kind for entry in entries] == ["user_message", "reasoning"]
    assert [entry.blocks[0].text for entry in entries] == ["recorded prompt", "recorded thought"]
    assert [entry.native_ordinal for entry in entries] == [8, 8]
    assert root.children == []
    assert root.llm_calls == []
