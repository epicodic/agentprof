# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import json
from pathlib import Path

from agentprof.adapters.claude_code.discovery import Subagent, SubagentMeta
from agentprof.adapters.claude_code.transcript import load_transcript
from agentprof.adapters.claude_code.tree import build_root
from agentprof.analysis.session_index import SessionIndex
from agentprof.analysis.transcripts import scope_coverage, scope_entries
from agentprof.model import Node, NodeKind, TranscriptEntry, iter_nodes
from agentprof.pricing import PriceTable

_T0 = "2026-09-20T10:00:00.000Z"


def _line(kind: str, uuid: str, content: object, seconds: int, **extra: object) -> dict[str, object]:
    timestamp = f"2026-09-20T10:00:{seconds:02d}.000Z"
    if kind == "assistant":
        message: dict[str, object] = {
            "role": "assistant",
            "id": extra.pop("message_id", uuid),
            "model": "claude-sonnet-5",
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "content": content,
        }
        stop_reason = extra.pop("stop_reason", None)
        if stop_reason is not None:
            message["stop_reason"] = stop_reason
    else:
        message = {"role": "user", "content": content}
    return {"type": kind, "uuid": uuid, "timestamp": timestamp, "message": message, **extra}


def _write(path: Path, records: list[dict[str, object]]) -> None:
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n", encoding="utf-8")


def _entries(root: Node) -> list[TranscriptEntry]:
    return [entry for node in iter_nodes(root) for entry in node.transcript_entries]


def test_retains_ordered_assistant_content_and_tool_result_mixed_with_user_text(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    _write(
        path,
        [
            _line("user", "u1", "prompt", 0),
            _line(
                "assistant",
                "a1",
                [
                    {"type": "thinking", "thinking": "reason"},
                    {"type": "text", "text": "answer"},
                    {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {"file_path": "x"}},
                ],
                1,
                message_id="m1",
            ),
            _line(
                "user",
                "r1",
                [
                    {"type": "text", "text": "ordinary user text"},
                    {"type": "tool_result", "tool_use_id": "tool-1", "content": ""},
                ],
                2,
            ),
            _line("user", "r2", [{"type": "tool_result", "tool_use_id": "tool-missing"}], 3),
            _line(
                "user",
                "r3",
                [{"type": "tool_result", "tool_use_id": "tool-structured", "content": {"payload": [1, 2]}}],
                4,
            ),
        ],
    )

    transcript = load_transcript(path)
    root = build_root(transcript, [], PriceTable.load(), "session")
    entries = _entries(root)

    assistant = [entry for entry in entries if entry.role == "assistant"]
    assert [entry.blocks[0].native_type for entry in assistant] == ["thinking", "text", "tool_use"]
    assert [entry.blocks[0].text for entry in assistant[:2]] == ["reason", "answer"]
    request = assistant[2]
    assert request.kind == "tool_request"
    assert request.invocation_id == "tool-1"
    assert request.source_request_id == "m1"
    assert request.logical_stream_id == transcript.source_stream_id
    assert request.event_id == "tool-start:tool-1"
    assert request.subject_node_id == "tool-1"
    assert all(
        (entry.invocation_id, entry.event_id, entry.subject_node_id) == (None, None, None) for entry in assistant[:2]
    )
    assert request.blocks[0].data == {
        "type": "tool_use",
        "id": "tool-1",
        "name": "Read",
        "input": {"file_path": "x"},
    }
    assert [entry.blocks[0].text for entry in entries if entry.role == "user" and entry.kind == "user_message"] == [
        "prompt",
        "ordinary user text",
    ]
    prompt_entry = next(entry for entry in entries if entry.native_id == "u1")
    assert prompt_entry.event_id == "user-input:u1"
    assert prompt_entry.subject_node_id == root.children[0].node_id
    assert scope_entries(SessionIndex(root), root.children[0].node_id, event_id="user-input:u1") == [prompt_entry]
    mixed_text_entry = next(entry for entry in entries if entry.blocks[0].text == "ordinary user text")
    assert (mixed_text_entry.event_id, mixed_text_entry.subject_node_id) == (None, None)
    result = next(entry for entry in entries if entry.kind == "tool_result")
    assert result.blocks[0].availability == "recorded"
    assert result.blocks[0].text == ""
    assert result.invocation_id == "tool-1"
    assert result.event_id == "tool-result:tool-1"
    missing_result = next(entry for entry in entries if entry.invocation_id == "tool-missing")
    assert missing_result.blocks[0].availability == "unavailable"
    assert missing_result.blocks[0].text is None
    structured_result = next(entry for entry in entries if entry.invocation_id == "tool-structured")
    assert structured_result.blocks[0].availability == "unsupported"
    assert structured_result.blocks[0].text is None
    assert structured_result.blocks[0].data == {
        "type": "tool_result",
        "tool_use_id": "tool-structured",
        "content": {"payload": [1, 2]},
    }
    tool_scope = scope_entries(SessionIndex(root), "tool-1")
    assert all(entry.invocation_id == "tool-1" for entry in tool_scope)
    assert all("ordinary user text" not in (entry.blocks[0].text or "") for entry in tool_scope)


def test_records_teammate_envelope_sender_and_send_message_recipient(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    body = (
        ' \n<teammate-message color="blue" teammate_id="worker-7" kind="message">'
        "\nPlease review.\n</teammate-message> \t\n"
    )
    _write(
        path,
        [
            _line("user", "u1", body, 0),
            _line(
                "assistant",
                "a1",
                [{"type": "tool_use", "id": "message-1", "name": "SendMessage", "input": {"recipient": "worker-7"}}],
                1,
            ),
        ],
    )

    root = build_root(load_transcript(path), [], PriceTable.load(), "session")
    entries = _entries(root)
    incoming = next(entry for entry in entries if entry.blocks[0].text == body)
    outgoing = next(entry for entry in entries if entry.kind == "tool_request")

    assert incoming.role == "user"
    assert incoming.sender == "worker-7"
    assert incoming.recipient is None
    assert outgoing.recipient == "worker-7"
    assert outgoing.sender is None


def test_does_not_infer_sender_from_incomplete_or_nonleading_teammate_tag(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    _write(
        path,
        [
            _line("user", "u1", '<teammate-message teammate_id="incomplete">', 0),
            _line("user", "u2", 'Note: <teammate-message teammate_id="quoted">hello</teammate-message>', 1),
        ],
    )

    entries = _entries(build_root(load_transcript(path), [], PriceTable.load(), "session"))

    assert all(entry.sender is None for entry in entries)


def test_does_not_infer_sender_from_teammate_envelope_with_trailing_user_text(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    body = (
        '<teammate-message color="blue" teammate_id="worker-7">Please review.</teammate-message> Here is my own note.'
    )
    _write(path, [_line("user", "u1", body, 0)])

    (entry,) = _entries(build_root(load_transcript(path), [], PriceTable.load(), "session"))

    assert entry.sender is None
    assert entry.blocks[0].text == body


def test_requires_one_exact_well_formed_teammate_id_attribute(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    bodies = [
        '<teammate-message teammate_id="worker-7" teammate_id="other">duplicate</teammate-message>',
        '<teammate-message fake-teammate_id="worker-7">fake name</teammate-message>',
        '<teammate-message teammate_id="worker-7" bogus>malformed attribute</teammate-message>',
        '<teammate-message teammate_id="">empty sender</teammate-message>',
    ]
    _write(path, [_line("user", f"u{index}", body, index) for index, body in enumerate(bodies)])

    entries = _entries(build_root(load_transcript(path), [], PriceTable.load(), "session"))

    assert [entry.sender for entry in entries] == [None] * len(bodies)
    assert [entry.blocks[0].text for entry in entries] == bodies


def test_distinguishes_missing_content_and_retains_meta_compaction_unknown_and_encrypted_blocks(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    records: list[dict[str, object]] = [
        _line("user", "u1", "prompt", 0),
        _line("assistant", "a1", [{"type": "redacted_thinking", "data": "secret"}], 1),
        _line(
            "assistant",
            "a2",
            [
                {"type": "summary", "summary": "reasoning recap"},
                {"type": "future_block", "payload": {"x": 1}},
            ],
            2,
        ),
        _line("user", "meta", [{"type": "text", "text": "meta"}], 3, isMeta=True),
        {"type": "user", "uuid": "missing", "message": {"role": "user"}},
        {"type": "system", "subtype": "compact_boundary", "timestamp": f"{_T0}", "uuid": "compact"},
    ]
    _write(path, records)

    root = build_root(load_transcript(path), [], PriceTable.load(), "session")
    entries = _entries(root)

    encrypted = next(entry for entry in entries if entry.blocks and entry.blocks[0].native_type == "redacted_thinking")
    assert encrypted.blocks[0].availability == "encrypted"
    assert encrypted.blocks[0].text is None and encrypted.blocks[0].data is None
    summary = next(entry for entry in entries if entry.blocks and entry.blocks[0].native_type == "summary")
    assert summary.blocks[0].kind == "reasoning_summary"
    assert summary.blocks[0].text == "reasoning recap"
    unknown = next(entry for entry in entries if entry.blocks and entry.blocks[0].native_type == "future_block")
    assert unknown.blocks[0].availability == "unsupported"
    assert unknown.blocks[0].data == {"type": "future_block", "payload": {"x": 1}}
    meta = next(entry for entry in entries if entry.native_id == "meta")
    assert meta.role == "user"
    assert meta.blocks[0].data == {"isMeta": True}
    missing = next(entry for entry in entries if entry.native_id == "missing")
    assert missing.blocks[0].availability == "unavailable"
    assert missing.timestamp.value is None
    compact = next(entry for entry in entries if entry.kind == "compaction")
    assert compact.timestamp.value is not None
    assert load_transcript(path).malformed_lines == 1
    coverage = scope_coverage(SessionIndex(root), root.children[0].node_id)
    assert "unavailable_content" in coverage.reasons
    assert root.children[0].kind is NodeKind.TURN


def test_keeps_repeated_message_occurrences_append_stable_ids_and_legacy_call_count(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    prefix = [
        _line("user", "u1", "prompt", 0),
        _line("assistant", "a1", [{"type": "text", "text": "same"}], 1, message_id="repeat"),
        _line("assistant", "a2", [{"type": "text", "text": "same"}], 2, message_id="repeat"),
    ]
    _write(path, prefix)
    first = _entries(build_root(load_transcript(path), [], PriceTable.load(), "session"))
    _write(path, [*prefix, _line("assistant", "a3", [{"type": "text", "text": "later"}], 3, message_id="last")])
    second = _entries(build_root(load_transcript(path), [], PriceTable.load(), "session"))

    repeats = [entry for entry in second if entry.native_id == "repeat"]
    assert len(repeats) == 2
    assert repeats[0].entry_id != repeats[1].entry_id
    assert {entry.entry_id for entry in first} <= {entry.entry_id for entry in second}
    turn = next(
        node
        for node in iter_nodes(build_root(load_transcript(path), [], PriceTable.load(), "session"))
        if node.kind is NodeKind.TURN
    )
    assert len(turn.llm_calls) == 2


def test_assigns_turn_ownership_by_source_position_despite_clock_regressions_and_keeps_prelude_at_root(
    tmp_path: Path,
) -> None:
    path = tmp_path / "session.jsonl"
    _write(
        path,
        [
            _line("assistant", "pre", [{"type": "text", "text": "before"}], 10),
            _line("user", "u1", "first", 20),
            _line("assistant", "a1", [{"type": "text", "text": "one"}], 5),
            _line("user", "u2", "second", 30),
            _line("assistant", "a2", [{"type": "text", "text": "two"}], 1),
        ],
    )

    root = build_root(load_transcript(path), [], PriceTable.load(), "session")

    assert [entry.native_id for entry in root.transcript_entries] == ["pre"]
    assert [[entry.native_id for entry in turn.transcript_entries] for turn in root.children] == [
        ["u1", "a1"],
        ["u2", "a2"],
    ]


def test_assigns_many_turns_by_source_order_when_assistant_clocks_regress(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    records: list[dict[str, object]] = []
    for index in range(40):
        records.append(_line("user", f"u{index}", f"prompt {index}", index))
        records.append(_line("assistant", f"a{index}", [{"type": "text", "text": f"reply {index}"}], 59 - index))
    _write(path, records)

    root = build_root(load_transcript(path), [], PriceTable.load(), "session")

    assert len(root.children) == 40
    assert [[entry.native_id for entry in turn.transcript_entries] for turn in root.children] == [
        [f"u{index}", f"a{index}"] for index in range(40)
    ]


def test_retains_subagent_content_on_agent_owner_and_no_timestamps(tmp_path: Path) -> None:
    main_path = tmp_path / "session.jsonl"
    child_path = tmp_path / "agent-child.jsonl"
    _write(main_path, [_line("user", "u1", "delegate", 0), _line("assistant", "a1", [], 1)])
    _write(
        child_path,
        [
            {
                "type": "assistant",
                "uuid": "child1",
                "message": {"id": "child-msg", "content": [{"type": "text", "text": "child"}]},
            },
        ],
    )
    main = load_transcript(main_path)
    child = load_transcript(child_path)
    subagent = Subagent(
        meta=SubagentMeta(agent_id="child", tool_use_id=None, agent_type=None, description=None, model=None),
        transcript=child,
    )

    root = build_root(main, [subagent], PriceTable.load(), "session")

    agent = next(node for node in iter_nodes(root) if node.kind is NodeKind.AGENT)
    assert len(agent.transcript_entries) == 1
    assert agent.transcript_entries[0].blocks[0].text == "child"
    assert agent.transcript_entries[0].timestamp.value is None
    assert child.malformed_lines == 1


def test_keeps_parent_delegation_content_and_child_transcript_under_child_agent(tmp_path: Path) -> None:
    main_path = tmp_path / "session.jsonl"
    child_path = tmp_path / "agent-child.jsonl"
    _write(
        main_path,
        [
            _line("user", "u1", "delegate", 0),
            _line(
                "assistant",
                "a1",
                [{"type": "tool_use", "id": "delegate-call", "name": "Agent", "input": {"description": "child"}}],
                1,
                message_id="parent-message",
            ),
            _line(
                "user",
                "r1",
                [
                    {
                        "type": "tool_result",
                        "tool_use_id": "delegate-call",
                        "content": "Async agent launched successfully.",
                    }
                ],
                2,
            ),
        ],
    )
    _write(child_path, [_line("assistant", "ca1", [{"type": "text", "text": "child output"}], 3)])
    child = load_transcript(child_path)
    subagent = Subagent(
        meta=SubagentMeta(agent_id="child", tool_use_id="delegate-call", agent_type=None, description=None, model=None),
        transcript=child,
    )

    root = build_root(load_transcript(main_path), [subagent], PriceTable.load(), "session")

    turn = root.children[0]
    agent = next(node for node in iter_nodes(root) if node.kind is NodeKind.AGENT)
    assert [entry.kind for entry in turn.transcript_entries] == ["user_message", "delegation", "tool_result"]
    assert turn.transcript_entries[1].invocation_id == "delegate-call"
    assert turn.transcript_entries[1].subject_node_id == agent.node_id
    assert turn.transcript_entries[2].invocation_id == "delegate-call"
    assert [entry.blocks[0].text for entry in agent.transcript_entries] == ["child output"]


def test_uses_physical_line_positions_and_distinct_physical_stream_identity(tmp_path: Path) -> None:
    first_path = tmp_path / "one" / "same.jsonl"
    second_path = tmp_path / "two" / "same.jsonl"
    first_path.parent.mkdir()
    second_path.parent.mkdir()
    payload = json.dumps(_line("assistant", "a1", [{"type": "text", "text": "same"}], 1, message_id="m1"))
    first_path.write_text("\n" + payload + "\n{broken\n", encoding="utf-8")
    second_path.write_text(payload + "\n", encoding="utf-8")

    first = load_transcript(first_path)
    second = load_transcript(second_path)
    first_entry = _entries(build_root(first, [], PriceTable.load(), "first"))[0]
    second_entry = _entries(build_root(second, [], PriceTable.load(), "second"))[0]

    assert first_entry.source_position == 2
    assert first_entry.native_ordinal == 0
    assert first.malformed_line_details[0].line_number == 3
    assert first.source_stream_id == second.source_stream_id == "claude-code:same"
    assert first_entry.source_stream_id != second_entry.source_stream_id
    assert first_entry.entry_id != second_entry.entry_id


def test_physical_stream_identity_survives_relocation_within_same_relative_source(tmp_path: Path) -> None:
    payload = json.dumps(_line("assistant", "a1", [{"type": "text", "text": "same"}], 1, message_id="m1"))
    first_path = tmp_path / "origin" / "project" / "session.jsonl"
    second_path = tmp_path / "relocated" / "project" / "session.jsonl"
    first_path.parent.mkdir(parents=True)
    second_path.parent.mkdir(parents=True)
    first_path.write_text(payload + "\n", encoding="utf-8")
    second_path.write_text(payload + "\n", encoding="utf-8")

    first = _entries(build_root(load_transcript(first_path), [], PriceTable.load(), "first"))[0]
    second = _entries(build_root(load_transcript(second_path), [], PriceTable.load(), "second"))[0]

    assert first.source_stream_id == second.source_stream_id
    assert first.entry_id == second.entry_id


def test_only_explicit_terminal_assistant_text_fills_turn_result(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    _write(
        path,
        [
            _line("user", "u1", "prompt", 0),
            _line("assistant", "a1", [{"type": "text", "text": "intermediate"}], 1, message_id="m1"),
            _line(
                "assistant",
                "a2",
                [{"type": "text", "text": "final first"}, {"type": "text", "text": "final second"}],
                2,
                message_id="m2",
                stop_reason="end_turn",
            ),
        ],
    )

    root = build_root(load_transcript(path), [], PriceTable.load(), "session")

    assert root.children[0].result == "final first\nfinal second"
