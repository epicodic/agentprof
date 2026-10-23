# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import base64
import json

import pytest

from agentprof.analysis import transcripts
from agentprof.analysis.identity import assign_call_keys
from agentprof.analysis.session_index import SessionIndex
from agentprof.analysis.transcripts import (
    TranscriptCursorError,
    decode_cursor,
    ordered_entries,
    page_entries,
    scope_entries,
    search_entries,
    supporting_references,
)
from agentprof.model import (
    LlmCall,
    Metric,
    Node,
    NodeKind,
    TranscriptBlock,
    TranscriptCoverage,
    TranscriptEntry,
    transcript_entry_id,
)


def _entry(
    entry_id: str,
    owner_id: str,
    stream: str,
    position: int,
    timestamp: Metric,
    text: str,
    *,
    source_request_id: str | None = None,
    logical_stream_id: str | None = None,
    invocation_id: str | None = None,
    event_id: str | None = None,
    subject_node_id: str | None = None,
) -> TranscriptEntry:
    return TranscriptEntry(
        entry_id=entry_id,
        owner_id=owner_id,
        source_stream_id=stream,
        source_position=position,
        timestamp=timestamp,
        kind="assistant_message",
        blocks=[TranscriptBlock(kind="text", text=text)],
        source_request_id=source_request_id,
        logical_stream_id=logical_stream_id,
        invocation_id=invocation_id,
        event_id=event_id,
        subject_node_id=subject_node_id,
    )


def test_entry_id_qualifies_stream_and_duplicate_native_ids_by_physical_position() -> None:
    first = transcript_entry_id("rollout-a", 2, native_id="same")
    duplicate = transcript_entry_id("rollout-a", 3, native_id="same")
    other_stream = transcript_entry_id("rollout-b", 2, native_id="same")

    assert len({first, duplicate, other_stream}) == 3
    assert first == transcript_entry_id("rollout-a", 2, native_id="same")


def test_entry_id_is_url_safe_when_physical_stream_names_contain_paths_or_separators() -> None:
    first = transcript_entry_id("rollout/a:native:b", 2, native_id="same/id")
    second = transcript_entry_id("rollout/a", 2, native_id="b:native:same/id")

    assert "/" not in first
    assert first != second


def test_entry_ids_do_not_collide_between_stream_and_native_id_components() -> None:
    first = transcript_entry_id("x:native:y", 1)
    second = transcript_entry_id("x", 1, native_id="y:record")

    assert first != second


def test_empty_content_is_recorded_and_absent_content_remains_unavailable() -> None:
    empty = TranscriptBlock(kind="text", text="")
    absent = TranscriptBlock(kind="text", text=None, availability="unavailable")
    present = Node(
        node_id="s",
        kind=NodeKind.SESSION,
        topic="s",
        transcript_entries=[_entry("e", "s", "x", 1, Metric.exact(1), "")],
    )
    absent_node = Node(node_id="a", kind=NodeKind.AGENT, topic="a")

    assert empty.availability == "recorded"
    assert present.transcript_entries[0].blocks[0].text == ""
    assert absent.text is None and absent.availability == "unavailable"
    assert present.transcript_coverage == TranscriptCoverage()
    assert absent_node.transcript_entries == []


def test_scope_excludes_nested_agents_and_tool_scope_uses_exact_invocation() -> None:
    root_entry = _entry("root", "s", "root", 1, Metric.exact(1), "root")
    turn_entry = _entry("turn", "t", "turn", 1, Metric.exact(2), "turn")
    parent_entry = _entry("parent", "a", "parent", 1, Metric.exact(3), "parent", invocation_id="tool-1")
    child_entry = _entry("child", "child", "child", 1, Metric.exact(4), "child")
    tool = Node(node_id="tool-1", kind=NodeKind.TOOL, topic="tool", tool=None)
    child = Node(node_id="child", kind=NodeKind.AGENT, topic="child", transcript_entries=[child_entry])
    agent = Node(node_id="a", kind=NodeKind.AGENT, topic="a", transcript_entries=[parent_entry], children=[child, tool])
    turn = Node(node_id="t", kind=NodeKind.TURN, topic="t", transcript_entries=[turn_entry], children=[agent])
    root = Node(node_id="s", kind=NodeKind.SESSION, topic="s", transcript_entries=[root_entry], children=[turn])

    assert [entry.entry_id for entry in scope_entries(SessionIndex(root))] == ["root", "turn", "parent", "child"]
    assert [entry.entry_id for entry in scope_entries(SessionIndex(root), "s")] == ["root", "turn"]
    assert [entry.entry_id for entry in scope_entries(SessionIndex(root), "a")] == ["parent"]
    assert [entry.entry_id for entry in scope_entries(SessionIndex(root), "t")] == ["turn"]
    assert [entry.entry_id for entry in scope_entries(SessionIndex(root), "tool-1")] == ["parent"]


def test_stream_order_survives_regressing_times_and_merge_uses_stream_heads() -> None:
    entries = [
        _entry("a1", "s", "a", 1, Metric.exact(10), "a1"),
        _entry("a2", "s", "a", 2, Metric.exact(5), "a2"),
        _entry("b1", "s", "b", 1, Metric.exact(7), "b1"),
        _entry("b2", "s", "b", 2, Metric.not_available(), "b2"),
    ]

    assert [entry.entry_id for entry in ordered_entries(entries)] == ["b1", "a1", "a2", "b2"]


def test_large_stream_merge_keeps_every_stream_in_source_order() -> None:
    entries = [
        _entry(
            f"{stream}-{position}",
            "s",
            f"stream-{stream:03d}",
            position,
            Metric.exact((stream * 11 + position * 7) % 31),
            "body",
        )
        for stream in range(48)
        for position in range(20)
    ]

    merged = ordered_entries(entries)

    assert len(merged) == 48 * 20
    assert {entry.entry_id for entry in merged} == {entry.entry_id for entry in entries}
    for stream in range(48):
        assert [entry.source_position for entry in merged if entry.source_stream_id == f"stream-{stream:03d}"] == list(
            range(20)
        )


def test_large_nested_transcript_filters_resolve_exact_call_and_event_once() -> None:
    from agentprof.model import ExecutionEvent

    root = Node(node_id="root", kind=NodeKind.SESSION, topic="root")
    root.llm_calls = [
        LlmCall(
            start=Metric.exact(index),
            call_id=f"call-{index}",
            source_request_id=f"request-{index}",
            source_stream_id="logical-main",
        )
        for index in range(320)
    ]
    root.execution_events = [
        ExecutionEvent(kind="message", event_id=f"event-{index}", source_stream_id="logical-main")
        for index in range(320)
    ]
    root.transcript_entries = [
        TranscriptEntry(
            entry_id=f"entry-{index}",
            owner_id="root",
            source_stream_id=f"physical-{index}",
            logical_stream_id="logical-main",
            source_position=index,
            timestamp=Metric.exact(index),
            kind="assistant_message",
            source_request_id=f"request-{index}",
            event_id=f"event-{index}",
            blocks=[TranscriptBlock(kind="text", text=f"message {index}")],
        )
        for index in range(320)
    ]
    parent = root
    for index in range(120):
        child = Node(node_id=f"nested-{index}", kind=NodeKind.AGENT, topic="nested")
        parent.children.append(child)
        parent = child

    assign_call_keys(root)
    call_matches = scope_entries(SessionIndex(root), "root", call_key="id:call-319")
    event_matches = scope_entries(SessionIndex(root), "root", event_id="event-319")

    assert [entry.entry_id for entry in call_matches] == ["entry-319"]
    assert [entry.entry_id for entry in event_matches] == ["entry-319"]


def test_search_reads_full_recorded_text_and_structured_data_but_skips_encrypted_blocks() -> None:
    entry = _entry("e1", "s", "stream", 1, Metric.exact(1), "x" * 300 + " Late Phrase")
    entry.blocks.append(TranscriptBlock(kind="data", data={"command": "Needle in arguments"}))
    entry.blocks.append(TranscriptBlock(kind="text", text="secret needle", availability="encrypted"))
    entry.blocks.append(TranscriptBlock(kind="data", data={"secret": "needle"}, availability="encrypted"))

    hits = search_entries([entry], "needle")

    assert len(hits) == 1
    assert hits[0].entry.entry_id == "e1"
    assert hits[0].block_position == 1
    assert len(hits[0].snippet) <= 240
    assert search_entries([entry], "secret") == []


def test_duplicate_native_call_ids_never_fall_back_to_timestamp() -> None:
    entry = _entry(
        "e1", "owner", "stream", 1, Metric.exact(3), "body", source_request_id="req", logical_stream_id="stream"
    )
    owner = Node(
        node_id="owner",
        kind=NodeKind.AGENT,
        topic="owner",
        llm_calls=[
            LlmCall(start=Metric.exact(3), call_id="duplicate", source_request_id="req", source_stream_id="stream"),
            LlmCall(start=Metric.exact(3), call_id="duplicate", source_request_id="req", source_stream_id="stream"),
        ],
    )

    assert supporting_references(SessionIndex(owner), entry) == []


def test_event_reference_requires_matching_logical_or_physical_source_stream() -> None:
    from agentprof.model import ExecutionEvent

    entry = _entry("e1", "owner", "physical", 1, Metric.exact(1), "body", event_id="event")
    owner = Node(
        node_id="owner",
        kind=NodeKind.AGENT,
        topic="owner",
        execution_events=[ExecutionEvent(kind="message", event_id="event", source_stream_id="other")],
    )

    assert supporting_references(SessionIndex(owner), entry) == []


def test_event_reference_accepts_either_recorded_physical_or_logical_stream_identity() -> None:
    from agentprof.model import ExecutionEvent

    entry = _entry("e1", "owner", "physical", 1, Metric.exact(1), "body", event_id="event", logical_stream_id="logical")
    owner = Node(
        node_id="owner",
        kind=NodeKind.AGENT,
        topic="owner",
        execution_events=[ExecutionEvent(kind="message", event_id="event", source_stream_id="physical")],
    )

    assert [(reference.kind, reference.key) for reference in supporting_references(SessionIndex(owner), entry)] == [
        ("event", "event")
    ]


def test_duplicate_owner_or_subject_node_ids_do_not_resolve_arbitrarily() -> None:
    entry = _entry(
        "e1", "owner", "stream", 1, Metric.exact(1), "body", subject_node_id="subject", source_request_id="request"
    )
    owner = Node(
        node_id="owner",
        kind=NodeKind.AGENT,
        topic="owner",
        transcript_entries=[entry],
        llm_calls=[
            LlmCall(start=Metric.exact(1), call_id="call", source_request_id="request", source_stream_id="stream")
        ],
    )
    duplicate_owner = Node(
        node_id="owner",
        kind=NodeKind.AGENT,
        topic="duplicate owner",
        llm_calls=[
            LlmCall(start=Metric.exact(1), call_id="call", source_request_id="request", source_stream_id="stream")
        ],
    )
    subject_a = Node(node_id="subject", kind=NodeKind.AGENT, topic="a")
    subject_b = Node(node_id="subject", kind=NodeKind.AGENT, topic="b")
    root = Node(
        node_id="root", kind=NodeKind.SESSION, topic="root", children=[owner, duplicate_owner, subject_a, subject_b]
    )

    assign_call_keys(root)

    assert supporting_references(SessionIndex(root), entry) == []

    unique_owner = Node(
        node_id="owner",
        kind=NodeKind.AGENT,
        topic="owner",
        llm_calls=[
            LlmCall(start=Metric.exact(1), call_id="call", source_request_id="request", source_stream_id="stream")
        ],
    )
    unique_owner.transcript_entries = [entry]
    unique_owner_root = Node(
        node_id="unique-root", kind=NodeKind.SESSION, topic="root", children=[unique_owner, subject_a, subject_b]
    )
    assign_call_keys(unique_owner_root)
    assert [
        (reference.kind, reference.key) for reference in supporting_references(SessionIndex(unique_owner_root), entry)
    ] == [("call", "id:call")]


def test_scope_rejects_ambiguous_node_id() -> None:
    root = Node(
        node_id="root",
        kind=NodeKind.SESSION,
        topic="root",
        children=[
            Node(node_id="duplicate", kind=NodeKind.AGENT, topic="first"),
            Node(node_id="duplicate", kind=NodeKind.AGENT, topic="second"),
        ],
    )

    with pytest.raises(KeyError, match="duplicate"):
        scope_entries(SessionIndex(root), "duplicate")


def test_decode_cursor_rejects_non_string_or_empty_direction_and_entry_id() -> None:
    for payload in ({"i": "entry", "d": []}, {"i": "entry", "d": {}}, {"i": "", "d": "next"}):
        cursor = (
            base64.urlsafe_b64encode(
                json.dumps({"s": "session", "o": None, "q": None, "c": None, "e": None, **payload}).encode()
            )
            .decode()
            .rstrip("=")
        )
        with pytest.raises(TranscriptCursorError):
            decode_cursor(
                cursor,
                session_id="session",
                scope_id=None,
                query=None,
                call_key=None,
                event_id=None,
            )


def test_search_snippet_is_at_most_240_codepoints_even_with_unicode_casefolding() -> None:
    entry = _entry("e1", "s", "stream", 1, Metric.exact(1), "x" * 239 + " Straße " + "y" * 300)

    (hit,) = search_entries([entry], "STRASSE")

    assert len(hit.snippet) <= 240
    assert "Straße" in hit.snippet


def test_call_reference_uses_existing_stable_key_and_exact_logical_stream() -> None:
    entry = _entry(
        "e1",
        "owner",
        "physical-continuation",
        1,
        Metric.exact(1),
        "call output",
        source_request_id="request",
        logical_stream_id="logical",
    )
    owner = Node(
        node_id="owner",
        kind=NodeKind.AGENT,
        topic="owner",
        llm_calls=[
            LlmCall(start=Metric.exact(1), call_id="call-id", source_request_id="request", source_stream_id="logical")
        ],
        transcript_entries=[entry],
    )

    assign_call_keys(owner)
    (reference,) = __import__(
        "agentprof.analysis.transcripts", fromlist=["supporting_references"]
    ).supporting_references(SessionIndex(owner), entry)

    assert (reference.kind, reference.owner_id, reference.key) == ("call", "owner", "id:call-id")


def test_tool_scope_uses_call_identity_not_tool_name() -> None:
    entry = _entry("e1", "owner", "stream", 1, Metric.exact(1), "out", invocation_id="invocation-id")
    tool = Node(
        node_id="invocation-id",
        kind=NodeKind.TOOL,
        topic="exec",
        tool=None,
    )
    owner = Node(node_id="owner", kind=NodeKind.AGENT, topic="owner", transcript_entries=[entry], children=[tool])
    root = Node(node_id="root", kind=NodeKind.SESSION, topic="root", children=[owner])

    assert [item.entry_id for item in scope_entries(SessionIndex(root), "invocation-id")] == ["e1"]


def test_search_rejects_whitespace_query() -> None:
    import pytest

    with pytest.raises(ValueError, match="blank"):
        search_entries([], "  \t")


def test_owner_scope_does_not_search_nested_agent() -> None:
    root = Node(node_id="s", kind=NodeKind.SESSION, topic="s")
    root.children = [
        Node(
            node_id="a",
            kind=NodeKind.AGENT,
            topic="a",
            transcript_entries=[_entry("own", "a", "a", 1, Metric.exact(1), "own")],
            children=[
                Node(
                    node_id="b",
                    kind=NodeKind.AGENT,
                    topic="b",
                    transcript_entries=[_entry("nested", "b", "b", 1, Metric.exact(2), "deep phrase")],
                )
            ],
        )
    ]

    assert [hit.entry.entry_id for hit in search_entries(scope_entries(SessionIndex(root), "a"), "phrase")] == []
    assert [hit.entry.entry_id for hit in search_entries(scope_entries(SessionIndex(root)), "phrase")] == ["nested"]


def _scoped_tree() -> Node:
    turn_entries = [
        _entry("t1", "t", "turn", 1, Metric.exact(2), "phrase one"),
        _entry("t2", "t", "turn", 2, Metric.exact(3), "phrase two"),
    ]
    agent_entry = _entry("a1", "a", "agent", 1, Metric.exact(4), "phrase three")
    agent = Node(node_id="a", kind=NodeKind.AGENT, topic="a", transcript_entries=[agent_entry])
    turn = Node(node_id="t", kind=NodeKind.TURN, topic="t", transcript_entries=turn_entries, children=[agent])
    return Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[turn])


def test_scope_entries_are_memoised_per_scope_on_the_index(monkeypatch: pytest.MonkeyPatch) -> None:
    index = SessionIndex(_scoped_tree())
    orderings: list[int] = []
    original = transcripts.ordered_entries

    def counting(entries: list[TranscriptEntry]) -> list[TranscriptEntry]:
        orderings.append(len(entries))
        return original(entries)

    monkeypatch.setattr(transcripts, "ordered_entries", counting)

    first = transcripts.scope_entries(index, "a")
    second = transcripts.scope_entries(index, "a")
    transcripts.scope_entries(index)

    assert second is first
    assert len(orderings) == 2


def test_search_and_page_keep_the_order_they_are_given(monkeypatch: pytest.MonkeyPatch) -> None:
    entries = transcripts.scope_entries(SessionIndex(_scoped_tree()))
    monkeypatch.setattr(transcripts, "ordered_entries", lambda _: pytest.fail("ordered again"))

    assert len(search_entries(entries, "phrase")) == 3
    page = page_entries(entries, limit=2, session_id="x", scope_id=None)

    assert page.entries == entries[:2]
