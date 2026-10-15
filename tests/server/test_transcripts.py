# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import base64
import json
from pathlib import Path

from fastapi.testclient import TestClient

from agentprof.adapters.base import AdapterConfig, SessionRef, SessionSummary
from agentprof.adapters.codex.adapter import CodexAdapter
from agentprof.model import (
    ExecutionEvent,
    LlmCall,
    Metric,
    Node,
    NodeKind,
    Session,
    ToolCategory,
    ToolInfo,
    TranscriptBlock,
    TranscriptEntry,
)
from agentprof.registry import Registry
from agentprof.server.app import create_app


class _TranscriptAdapter:
    name = "synthetic"

    def discover(self) -> list[SessionRef]:
        return [SessionRef("synthetic", "one", Path("one.jsonl"), 42.0)]

    def open_path(self, path: Path) -> SessionRef | None:
        return None

    def summarize(self, ref: SessionRef) -> SessionSummary:
        return SessionSummary(ref.id, ref.agent, "synthetic", None, None, None, 0)

    def analyze(self, ref: SessionRef) -> Session:
        child = Node(node_id="child", kind=NodeKind.AGENT, topic="child")
        root = Node(node_id="root", kind=NodeKind.SESSION, topic="root")
        root.llm_calls = [
            LlmCall(start=Metric.exact(2), call_id="call-2", source_request_id="req-2", source_stream_id="main")
        ]
        root.execution_events = [ExecutionEvent(kind="message", event_id="event-2", source_stream_id="main")]
        tool = Node(
            node_id="tool-id",
            kind=NodeKind.TOOL,
            topic="exec",
            tool=ToolInfo(native_id="exec_command", category=ToolCategory.SHELL),
        )
        root.transcript_entries = [
            TranscriptEntry(
                entry_id=f"entry-{index}",
                owner_id="root",
                source_stream_id="main",
                source_position=index,
                timestamp=Metric.exact(index),
                kind="assistant_message",
                role="assistant",
                ownership_evidence="root_fallback" if index == 2 else None,
                sender="/root/task" if index == 2 else None,
                recipient="/root" if index == 2 else None,
                blocks=[
                    TranscriptBlock(
                        kind="text", text=("x" * 300 + " FULL BODY FIND" if index == 2 else f"message {index}")
                    )
                ],
                source_request_id="req-2" if index == 2 else None,
                logical_stream_id="main" if index == 2 else None,
                invocation_id="tool-id" if index == 2 else None,
                event_id="event-2" if index == 2 else None,
                subject_node_id="tool-id" if index == 2 else None,
            )
            for index in range(5)
        ]
        child.transcript_entries = [
            TranscriptEntry(
                entry_id="child-entry",
                owner_id="child",
                source_stream_id="child-stream",
                source_position=1,
                timestamp=Metric.exact(5),
                kind="user_message",
                blocks=[TranscriptBlock(kind="text", text="nested target phrase")],
            )
        ]
        root.children = [child, tool]
        return Session(ref.id, ref.agent, "synthetic", None, root)


def _client() -> TestClient:
    registry = Registry([_TranscriptAdapter()])
    registry.refresh()
    return TestClient(create_app(registry))


def test_transcript_list_is_bounded_and_omits_full_content() -> None:
    response = _client().get("/api/sessions/synthetic:one/transcript?limit=2")

    assert response.status_code == 200
    body = response.json()
    assert len(body["entries"]) == 2
    assert len(body["entries"][0]["preview"]) <= 240
    assert "blocks" not in body["entries"][0]
    assert body["next_cursor"]
    assert body["mtime"] == 42.0
    assert body["entries"][0]["sender"] is None
    assert body["entries"][0]["recipient"] is None


def test_transcript_list_exposes_participants_without_blocks() -> None:
    response = _client().get("/api/sessions/synthetic:one/transcript?limit=3")

    assert response.status_code == 200
    entry = response.json()["entries"][2]
    assert entry["role"] == "assistant"
    assert (entry["sender"], entry["recipient"]) == ("/root/task", "/root")
    assert "blocks" not in entry


def test_codex_agent_message_participants_survive_list_search_and_detail() -> None:
    fixtures = Path(__file__).parents[1] / "adapters/codex/fixtures/sessions"
    registry = Registry([CodexAdapter(AdapterConfig(roots={"codex": fixtures}))])
    registry.refresh()
    client = TestClient(create_app(registry))
    path = "/api/sessions/codex:root-session/transcript"

    page = client.get(path, params={"limit": 100}).json()
    entry = next(entry for entry in page["entries"] if entry.get("sender") == "/root/task")
    search = client.get(f"{path}/search", params={"q": "Documentation reviewed."}).json()
    hit = next(hit for hit in search["hits"] if hit["entry_id"] == entry["entry_id"])
    detail = client.get(f"{path}/entries/{entry['entry_id']}").json()

    assert (entry["role"], entry["sender"], entry["recipient"]) == (None, "/root/task", "/root")
    assert (hit["role"], hit["sender"], hit["recipient"]) == (None, "/root/task", "/root")
    assert (detail["role"], detail["sender"], detail["recipient"]) == (None, "/root/task", "/root")
    assert detail["blocks"][0]["text"] == "Documentation reviewed."


def test_transcript_anchor_and_cursor_context_and_refresh_conflict() -> None:
    client = _client()
    path = "/api/sessions/synthetic:one/transcript"
    page = client.get(path, params={"limit": 2}).json()
    next_page = client.get(path, params={"limit": 2, "after": page["next_cursor"]})
    anchored = client.get(path, params={"limit": 2, "anchor": "entry-2"})

    assert [entry["entry_id"] for entry in next_page.json()["entries"]] == ["entry-2", "entry-3"]
    assert next_page.json()["previous_cursor"]
    previous_page = client.get(path, params={"limit": 2, "after": next_page.json()["previous_cursor"]})
    assert [entry["entry_id"] for entry in previous_page.json()["entries"]] == ["entry-0", "entry-1"]
    assert anchored.json()["anchor_index"] == 1
    assert client.get(path, params={"after": "bad"}).status_code == 422
    assert client.get(path, params={"after": page["next_cursor"], "anchor": "entry-2"}).status_code == 422
    assert client.get(path, params={"node_id": "root", "after": page["next_cursor"]}).status_code == 422


def test_transcript_route_returns_422_for_unhashable_or_empty_cursor_fields() -> None:
    client = _client()
    path = "/api/sessions/synthetic:one/transcript"
    base = {"s": "synthetic:one", "o": None, "q": None, "c": None, "e": None}

    for values in ({"i": "entry", "d": []}, {"i": "entry", "d": {}}, {"i": "", "d": "next"}):
        payload = base64.urlsafe_b64encode(json.dumps({**base, **values}).encode()).decode().rstrip("=")
        assert client.get(path, params={"after": payload}).status_code == 422


def test_transcript_route_rejects_cursor_with_invalid_base64_alphabet() -> None:
    client = _client()
    path = "/api/sessions/synthetic:one/transcript"
    first = client.get(path, params={"limit": 1}).json()

    response = client.get(path, params={"limit": 1, "after": f"{first['next_cursor']}!!!!"})

    assert response.status_code == 422


def test_disappeared_cursor_entry_returns_conflict_and_search_cursor_binds_query() -> None:
    registry = Registry([_TranscriptAdapter()])
    registry.refresh()
    client = TestClient(create_app(registry))
    path = "/api/sessions/synthetic:one/transcript"
    first = client.get(path, params={"limit": 2}).json()
    # A changed transcript is a new analysis, so drop the entry in a fresh registry, not in the memoised one.
    registry = Registry([_TranscriptAdapter()])
    registry.refresh()
    client = TestClient(create_app(registry))
    session, _ = registry.session("synthetic:one")
    session.root.transcript_entries = session.root.transcript_entries[2:]

    assert client.get(path, params={"limit": 2, "after": first["next_cursor"]}).status_code == 409
    search = client.get(f"{path}/search", params={"q": "message", "limit": 1}).json()
    assert client.get(f"{path}/search", params={"q": "different", "after": search["next_cursor"]}).status_code == 422


def test_transcript_detail_and_search_use_full_content_not_preview() -> None:
    client = _client()
    path = "/api/sessions/synthetic:one/transcript"
    search = client.get(f"{path}/search", params={"q": "full body find"})

    assert search.status_code == 200
    (hit,) = search.json()["hits"]
    assert hit["entry_id"] == "entry-2"
    detail = client.get(f"{path}/entries/entry-2")
    assert detail.status_code == 200
    assert "FULL BODY FIND" in detail.json()["blocks"][0]["text"]
    assert "blocks" not in search.json()["hits"][0]
    assert search.json()["hits"][0]["role"] == "assistant"
    assert (search.json()["hits"][0]["sender"], search.json()["hits"][0]["recipient"]) == ("/root/task", "/root")
    assert search.json()["hits"][0]["ownership_evidence"] == "root_fallback"
    assert (detail.json()["sender"], detail.json()["recipient"]) == ("/root/task", "/root")


def test_transcript_search_preserves_root_fallback_user_ownership_evidence() -> None:
    registry = Registry([_TranscriptAdapter()])
    registry.refresh()
    session, _ = registry.session("synthetic:one")
    entry = next(entry for entry in session.root.transcript_entries if entry.entry_id == "entry-2")
    entry.kind = "user_message"
    entry.role = "user"
    entry.sender = None
    entry.recipient = None
    client = TestClient(create_app(registry))

    response = client.get(
        "/api/sessions/synthetic:one/transcript/search",
        params={"q": "full body find"},
    )

    assert response.status_code == 200
    (hit,) = response.json()["hits"]
    assert hit["kind"] == "user_message"
    assert hit["role"] == "user"
    assert hit["ownership_evidence"] == "root_fallback"
    assert "blocks" not in hit


def test_entry_detail_resolves_unique_recorded_supporting_references() -> None:
    detail = _client().get("/api/sessions/synthetic:one/transcript/entries/entry-2").json()

    assert {(ref["kind"], ref["owner_id"], ref["key"]) for ref in detail["references"]} == {
        ("call", "root", "id:call-2"),
        ("event", "root", "event-2"),
        ("node", "tool-id", "tool-id"),
    }
    assert detail["coverage"]["source_present"] is True


def test_transcript_routes_appear_in_api_discovery_and_openapi() -> None:
    client = _client()
    discovered = {(item["method"], item["path"]) for item in client.get("/api").json()["endpoints"]}
    paths = client.get("/openapi.json").json()["paths"]

    assert ("GET", "/api/sessions/{session_id}/transcript") in discovered
    assert ("GET", "/api/sessions/{session_id}/transcript/search") in discovered
    assert ("GET", "/api/sessions/{session_id}/transcript/entries/{entry_id}") in discovered
    assert "/api/sessions/{session_id}/transcript" in paths


def test_call_and_event_filters_require_owner_and_match_exact_reference_keys() -> None:
    client = _client()
    path = "/api/sessions/synthetic:one/transcript"

    call = client.get(path, params={"node_id": "root", "call_key": "id:call-2"})
    event = client.get(path, params={"node_id": "root", "event_id": "event-2"})

    assert [entry["entry_id"] for entry in call.json()["entries"]] == ["entry-2"]
    assert [entry["entry_id"] for entry in event.json()["entries"]] == ["entry-2"]
    assert client.get(path, params={"call_key": "id:call-2"}).status_code == 422


def test_transcript_search_scope_and_bad_queries() -> None:
    client = _client()
    path = "/api/sessions/synthetic:one/transcript/search"

    assert client.get(path, params={"q": "nested target", "node_id": "root"}).json()["hits"] == []
    assert client.get(path, params={"q": "nested target"}).json()["hits"][0]["entry_id"] == "child-entry"
    assert client.get(path, params={"q": "  "}).status_code == 422
    assert client.get(path, params={"q": "x", "limit": 0}).status_code == 422


def test_transcript_missing_scope_entry_and_session_return_404() -> None:
    client = _client()
    assert client.get("/api/sessions/synthetic:one/transcript?node_id=missing").status_code == 404
    assert client.get("/api/sessions/synthetic:one/transcript?anchor=missing").status_code == 404
    assert client.get("/api/sessions/synthetic:one/transcript/entries/bad").status_code == 404
    assert client.get("/api/sessions/absent/transcript").status_code == 404
