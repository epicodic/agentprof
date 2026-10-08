# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import asyncio
import json
import threading
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi.testclient import TestClient

from agentprof.adapters.base import AdapterConfig
from agentprof.adapters.claude_code.adapter import ClaudeCodeAdapter
from agentprof.model import CostMetric, Finding, Metric, Provenance, iter_nodes
from agentprof.pricing import PriceTable
from agentprof.registry import EventKind, Registry, RegistryEvent
from agentprof.server.app import Broadcaster, create_app, event_stream, format_event, static_file

_CLAUDE_PROJECTS = Path(__file__).parent.parent / "adapters" / "claude_code" / "fixtures" / "projects"
_SESSION_ID = "claude-code:11111111-1111-4111-8111-111111111111"


def _registry() -> Registry:
    registry = Registry([ClaudeCodeAdapter(AdapterConfig(roots={"claude-code": _CLAUDE_PROJECTS}))])
    registry.refresh()
    while registry.step():
        pass
    return registry


def test_list_sessions_returns_the_rows() -> None:
    client = TestClient(create_app(_registry()))

    response = client.get("/api/sessions")

    assert response.status_code == 200
    (row,) = response.json()
    assert (row["id"], row["title"], row["state"]) == (_SESSION_ID, "Fix the parser", "summarized")
    assert row["cost_total"]["unit"] == "USD"


def test_api_index_lists_public_endpoints_and_parameters() -> None:
    response = TestClient(create_app(_registry())).get("/api")

    assert response.status_code == 200
    entries = {(entry["method"], entry["path"]): entry for entry in response.json()["endpoints"]}
    assert ("GET", "/api") in entries
    assert ("GET", "/api/pricing") in entries
    assert ("GET", "/api/sessions") in entries
    assert ("GET", "/api/sessions/events") in entries
    assert ("GET", "/api/sessions/{session_id}") in entries
    assert ("GET", "/api/sessions/{session_id}/summary") in entries
    assert ("GET", "/api/sessions/{session_id}/findings") in entries
    assert ("GET", "/api/sessions/{session_id}/nodes/{node_id}") in entries
    assert entries[("GET", "/api/sessions/{session_id}")]["parameters"] == ["session_id", "depth", "fields"]
    assert all(entry["description"] for entry in entries.values())


def test_pricing_endpoint_reports_effective_bundled_table() -> None:
    client = TestClient(create_app(_registry()))

    response = client.get("/api/pricing")

    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "Anthropic API list prices, 2026-06-24"
    assert body["date"] == "2026-06-24"
    assert body["unit"] == "USD per million tokens"
    assert body["usd_per_credit"] == 0.01
    assert body["matching_rule"] == "longest_model_prefix"
    assert body["models"]["claude-sonnet-5"] == {
        "input": 2.0,
        "output": 10.0,
        "cache_read": 0.2,
        "cache_write_5m": 2.5,
        "cache_write_1h": 4.0,
    }


def test_pricing_endpoint_reports_supplied_override(tmp_path: Path) -> None:
    path = tmp_path / "pricing.json"
    path.write_text(
        json.dumps(
            {
                "source": "Example",
                "date": "2026-10-02",
                "usd_per_credit": 0.02,
                "models": {
                    "example": {"input": 1, "output": 2, "cache_read": 3, "cache_write_5m": 4, "cache_write_1h": 5}
                },
            }
        )
    )
    client = TestClient(create_app(_registry(), pricing=PriceTable.load(path)))

    body = client.get("/api/pricing").json()

    assert body["source"] == "Example"
    assert body["date"] == "2026-10-02"
    assert body["usd_per_credit"] == 0.02
    assert body["models"] == {
        "example": {"input": 1, "output": 2, "cache_read": 3, "cache_write_5m": 4, "cache_write_1h": 5}
    }


def test_api_index_accepts_a_trailing_slash() -> None:
    client = TestClient(create_app(_registry()))

    assert client.get("/api/").json() == client.get("/api").json()


def test_get_session_returns_the_tree() -> None:
    client = TestClient(create_app(_registry()))

    response = client.get(f"/api/sessions/{_SESSION_ID}")

    assert response.status_code == 200
    body = response.json()
    assert body["root"]["kind"] == "session"
    assert [turn["node_id"] for turn in body["root"]["children"]] == ["u1", "u2"]
    assert body["diagnostics"]["unknown_tool_ids"] == {"FancyNewTool": 1}
    assert "children_omitted" not in body["root"]


def test_get_session_depth_limits_descendants_and_marks_omissions() -> None:
    client = TestClient(create_app(_registry()))

    response = client.get(f"/api/sessions/{_SESSION_ID}?depth=1")

    assert response.status_code == 200
    root = response.json()["root"]
    assert root["children_omitted"] is False
    assert [turn["node_id"] for turn in root["children"]] == ["u1", "u2"]
    assert all(turn["children"] == [] for turn in root["children"])
    assert any(turn["children_omitted"] for turn in root["children"])


def test_get_session_depth_zero_keeps_root_and_reports_omission() -> None:
    response = TestClient(create_app(_registry())).get(f"/api/sessions/{_SESSION_ID}?depth=0")

    assert response.status_code == 200
    assert response.json()["root"]["children"] == []
    assert response.json()["root"]["children_omitted"] is True


def test_get_session_fields_selects_documented_top_level_groups() -> None:
    client = TestClient(create_app(_registry()))
    path = f"/api/sessions/{_SESSION_ID}"

    metadata = client.get(f"{path}?fields=session")
    chosen = client.get(f"{path}?fields=session,diagnostics")
    tree = client.get(f"{path}?fields=tree&depth=0")

    assert set(metadata.json()) == {"id", "agent", "title", "workspace", "mtime", "sources"}
    assert set(chosen.json()) == {*metadata.json(), "diagnostics"}
    assert set(tree.json()) == {"root"}
    assert tree.json()["root"]["children_omitted"] is True


def test_get_session_rejects_invalid_depth_and_fields() -> None:
    client = TestClient(create_app(_registry()))
    path = f"/api/sessions/{_SESSION_ID}"

    assert client.get(f"{path}?depth=-1").status_code == 422
    assert client.get(f"{path}?depth=abc").status_code == 422
    fields = client.get(f"{path}?fields=session,unknown")
    assert fields.status_code == 422
    assert "session, diagnostics, tree" in fields.json()["detail"]


def test_get_session_query_parameters_are_documented_in_openapi() -> None:
    schema = TestClient(create_app(_registry())).get("/openapi.json").json()
    parameters = schema["paths"]["/api/sessions/{session_id}"]["get"]["parameters"]
    query_parameters = {parameter["name"]: parameter for parameter in parameters if parameter["in"] == "query"}

    assert set(query_parameters) == {"depth", "fields"}
    assert "root is 0" in query_parameters["depth"]["description"]
    assert "children_omitted" in query_parameters["depth"]["description"]
    assert "session (identity and sources), diagnostics, tree (root)" in query_parameters["fields"]["description"]


def test_get_diagnostics_returns_bounded_malformed_line_details() -> None:
    client = TestClient(create_app(_registry()))

    response = client.get(f"/api/sessions/{_SESSION_ID}/diagnostics")

    assert response.status_code == 200
    body = response.json()
    assert body["malformed_lines"] == 1
    assert body["unknown_tool_ids"] == {"FancyNewTool": 1}
    assert len(body["malformed_line_details"]) == 1
    detail = body["malformed_line_details"][0]
    assert detail["source_path"].endswith(f"{_SESSION_ID.removeprefix('claude-code:')}.jsonl")
    assert detail["line_number"] > 0
    assert detail["error_category"] == "invalid_json"
    assert len(detail["excerpt"]) <= 120
    assert client.get("/api/sessions/claude-code:missing/diagnostics").status_code == 404


def test_agent_summary_returns_compact_rows() -> None:
    client = TestClient(create_app(_registry()))
    response = client.get(f"/api/sessions/{_SESSION_ID}/summary")

    assert response.status_code == 200
    body = response.json()
    assert body["schema_version"] == 1
    assert body["id"] == _SESSION_ID
    assert body["mtime"] > 0
    assert body["agents"][0]["agent_id"] == 1
    assert "root" not in body
    assert "prompt" not in body["agents"][0]
    assert "own_cost" in body["agents"][0]
    assert "subtree_cost" in body["agents"][0]


def test_findings_endpoint_flattens_attached_findings() -> None:
    registry = _registry()
    session, _ = registry.session(_SESSION_ID)
    expected = [finding.heuristic_id for node in iter_nodes(session.root) for finding in node.findings]

    response = TestClient(create_app(registry)).get(f"/api/sessions/{_SESSION_ID}/findings")

    assert response.status_code == 200
    assert sorted(item["heuristic_id"] for item in response.json()) == sorted(expected)
    assert all("node_id" in item and "severity" in item for item in response.json())
    assert TestClient(create_app(registry)).get("/api/sessions/claude-code:missing/findings").status_code == 404


def test_findings_endpoint_sorts_unknown_cost_by_severity_then_time() -> None:
    registry = _registry()
    session, _ = registry.session(_SESSION_ID)
    nodes = list(iter_nodes(session.root))
    earlier, later = nodes[1], nodes[2]
    earlier.start = Metric.exact(10)
    later.start = Metric.exact(20)
    earlier.findings = [
        Finding(heuristic_id="low", node_id=earlier.node_id, severity="low", message="low"),
        Finding(heuristic_id="high", node_id=earlier.node_id, severity="high", message="high"),
    ]
    later.findings = [
        Finding(heuristic_id="high-later", node_id=later.node_id, severity="high", message="high later"),
        Finding(heuristic_id="medium", node_id=later.node_id, severity="medium", message="medium"),
    ]
    session.root.findings = []
    for node in nodes[3:]:
        node.findings = []

    response = TestClient(create_app(registry)).get(f"/api/sessions/{_SESSION_ID}/findings")

    assert response.status_code == 200
    assert [item["heuristic_id"] for item in response.json()] == ["high", "high-later", "medium", "low"]


def test_findings_endpoint_sorts_known_estimated_cost_first() -> None:
    registry = _registry()
    session, _ = registry.session(_SESSION_ID)
    nodes = list(iter_nodes(session.root))
    owner = nodes[1]
    owner.findings = [
        Finding(heuristic_id="unknown", node_id=owner.node_id, severity="high", message="unknown"),
        Finding(
            heuristic_id="small",
            node_id=owner.node_id,
            severity="low",
            message="small",
            estimated_avoidable_cost=CostMetric(1.0, "USD", Provenance.ESTIMATED),
        ),
        Finding(
            heuristic_id="large",
            node_id=owner.node_id,
            severity="low",
            message="large",
            estimated_avoidable_cost=CostMetric(3.0, "USD", Provenance.ESTIMATED),
        ),
    ]
    for node in nodes[:1] + nodes[2:]:
        node.findings = []

    response = TestClient(create_app(registry)).get(f"/api/sessions/{_SESSION_ID}/findings")

    assert response.status_code == 200
    assert [item["heuristic_id"] for item in response.json()] == ["large", "small", "unknown"]
    assert response.json()[0]["estimated_avoidable_cost"]["usd"] == 3.0


def test_agent_summary_reconciles_with_full_session() -> None:
    client = TestClient(create_app(_registry()))
    summary = client.get(f"/api/sessions/{_SESSION_ID}/summary").json()
    session = client.get(f"/api/sessions/{_SESSION_ID}").json()
    own_usd = [row["own_cost"]["usd"] for row in summary["agents"]]
    known_costs = [value for value in own_usd if value is not None]

    assert len(known_costs) == len(own_usd)
    assert abs(sum(known_costs) - session["root"]["cost_total"]["usd"]) < 1e-8
    assert summary["agents"][0]["subtree_cost"] == session["root"]["cost_total"]
    assert client.get("/api/sessions/claude-code:missing/summary").status_code == 404


def test_session_page_returns_json_when_explicitly_requested(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<html><head></head><body>app</body></html>", encoding="utf-8")
    client = TestClient(create_app(_registry(), static_dir=tmp_path))
    page = f"/sessions/{_SESSION_ID.replace(':', '%3A')}"

    for response in (
        client.get(page, headers={"Accept": "application/json"}),
        client.get(f"{page}?format=json"),
    ):
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/json")
        assert response.json()["id"] == _SESSION_ID
    assert client.get(page, headers={"Accept": "text/html"}).text.endswith("</html>")


def test_session_page_json_errors_match_api_errors(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<html><head></head></html>", encoding="utf-8")
    client = TestClient(create_app(_registry(), static_dir=tmp_path))

    assert client.get("/sessions/claude-code%3Amissing?format=json").status_code == 404
    assert client.get("/sessions/claude-code%3Amissing", headers={"Accept": "application/json"}).status_code == 404


def test_session_page_does_not_select_json_at_zero_quality(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<html><head></head><body>app</body></html>", encoding="utf-8")
    client = TestClient(create_app(_registry(), static_dir=tmp_path))
    page = f"/sessions/{_SESSION_ID.replace(':', '%3A')}"

    for accept in ("application/json;q=0", "application/json;q=0.0"):
        response = client.get(page, headers={"Accept": accept})
        assert response.headers["content-type"].startswith("text/html")


def test_session_html_points_to_its_json_and_the_api(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<html><head></head><body>app</body></html>", encoding="utf-8")
    client = TestClient(create_app(_registry(), static_dir=tmp_path))
    response = client.get(f"/sessions/{_SESSION_ID.replace(':', '%3A')}", headers={"Accept": "text/html"})

    assert response.status_code == 200
    assert '<link rel="alternate" type="application/json"' in response.text
    assert f"/api/sessions/{_SESSION_ID.replace(':', '%3A')}" in response.text
    assert "<!-- API discovery: /api -->" in response.text
    assert response.headers["cache-control"] == "no-cache"


def test_get_node_returns_its_texts() -> None:
    client = TestClient(create_app(_registry()))

    response = client.get(f"/api/sessions/{_SESSION_ID}/nodes/toolu_read1")

    assert response.status_code == 200
    assert response.json()["result"] == "   10\tdef parse():"
    assert response.json()["arguments"]["file_path"] == "/home/user/demo/parser.py"


def test_unknown_ids_return_404() -> None:
    client = TestClient(create_app(_registry()))

    assert client.get("/api/sessions/claude-code:missing").status_code == 404
    assert client.get(f"/api/sessions/{_SESSION_ID}/nodes/missing").status_code == 404


def test_an_unreadable_session_returns_422(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    project = projects / "-p"
    project.mkdir(parents=True)
    session_file = project / "s.jsonl"
    session_file.write_text('{"type": "user", "sessionId": "s"}\n', encoding="utf-8")
    registry = Registry([ClaudeCodeAdapter(AdapterConfig(roots={"claude-code": projects}))])
    registry.refresh()
    session_file.chmod(0)
    try:
        response = TestClient(create_app(registry)).get("/api/sessions/claude-code:s")
        summary_response = TestClient(create_app(registry)).get("/api/sessions/claude-code:s/summary")
    finally:
        session_file.chmod(0o644)

    assert response.status_code == 422
    assert summary_response.status_code == 422
    assert "PermissionError" in response.json()["detail"]


def test_index_serves_a_placeholder_page_without_frontend_assets(tmp_path: Path) -> None:
    response = TestClient(create_app(_registry(), static_dir=tmp_path)).get("/")

    assert response.status_code == 200
    assert "frontend" in response.text


def test_serves_frontend_assets_and_falls_back_to_index(tmp_path: Path) -> None:
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html>app</html>", encoding="utf-8")
    (tmp_path / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    client = TestClient(create_app(_registry(), static_dir=tmp_path))

    assert client.get("/").text == "<html>app</html>"
    session_html = client.get("/sessions/claude-code%3Aabc").text
    assert "<html>app</html>" in session_html
    assert 'href="/api/sessions/claude-code%3Aabc"' in session_html
    script = client.get("/assets/app.js")
    assert script.text == "console.log(1)"
    assert "javascript" in script.headers["content-type"]
    assert client.get("/api/sessions").status_code == 200
    assert client.get("/api/unknown").status_code == 404
    assert client.get("/unknown").status_code == 404
    assert client.get("/assets/missing.js").status_code == 404


def test_static_file_never_escapes_the_static_directory(tmp_path: Path) -> None:
    static = tmp_path / "static"
    static.mkdir()
    (static / "a.js").write_text("a", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("secret", encoding="utf-8")

    assert static_file(static, "a.js") == (static / "a.js").resolve()
    assert static_file(static, "../secret.txt") is None
    assert static_file(static, "") is None
    assert static_file(static, "missing.js") is None


def test_format_event_serialises_updates_and_removals() -> None:
    registry = _registry()

    updated = format_event(RegistryEvent(kind=EventKind.UPDATED, session_id=_SESSION_ID), registry)
    removed = format_event(RegistryEvent(kind=EventKind.REMOVED, session_id="x:y"), registry)
    unknown = format_event(RegistryEvent(kind=EventKind.UPDATED, session_id="x:y"), registry)

    assert updated is not None and updated.startswith("event: updated\ndata: ")
    assert json.loads(updated.split("data: ", 1)[1])["id"] == _SESSION_ID
    assert removed == 'event: removed\ndata: {"id": "x:y"}\n\n'
    assert unknown is None


def test_event_stream_yields_messages_and_keep_alives() -> None:
    async def scenario() -> list[str]:
        queue: asyncio.Queue[RegistryEvent | None] = asyncio.Queue()
        polls = 0

        async def is_disconnected() -> bool:
            nonlocal polls
            polls += 1
            return polls > 3

        await queue.put(RegistryEvent(kind=EventKind.REMOVED, session_id="a"))
        stream = event_stream(queue, lambda event: f"msg {event.session_id}\n\n", is_disconnected, keep_alive_s=0.01)
        return [message async for message in stream]

    assert asyncio.run(scenario()) == [": connected\n\n", "msg a\n\n", ": keep-alive\n\n", ": keep-alive\n\n"]


def test_event_stream_ends_when_the_broadcaster_ends_streams() -> None:
    async def scenario() -> list[str]:
        broadcaster = Broadcaster()
        broadcaster.bind(asyncio.get_running_loop())
        queue = broadcaster.open()

        async def is_disconnected() -> bool:
            return False

        threading.Thread(target=broadcaster.end_streams).start()
        stream = event_stream(queue, lambda event: "msg\n\n", is_disconnected, keep_alive_s=5)
        return await asyncio.wait_for(_collect(stream), timeout=2)

    assert asyncio.run(scenario()) == [": connected\n\n"]


async def _collect(stream: AsyncIterator[str]) -> list[str]:
    return [message async for message in stream]


def test_hashed_assets_are_cached_forever_and_index_never(tmp_path: Path) -> None:
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html>app</html>", encoding="utf-8")
    (tmp_path / "assets" / "app-1a2b.js").write_text("x", encoding="utf-8")
    client = TestClient(create_app(_registry(), static_dir=tmp_path))

    assert client.get("/assets/app-1a2b.js").headers["cache-control"] == "public, max-age=31536000, immutable"
    assert client.get("/").headers["cache-control"] == "no-cache"
    assert client.get("/sessions/x").headers["cache-control"] == "no-cache"


def test_broadcaster_delivers_events_published_from_another_thread() -> None:
    async def scenario() -> RegistryEvent | None:
        broadcaster = Broadcaster()
        broadcaster.bind(asyncio.get_running_loop())
        queue = broadcaster.open()
        event = RegistryEvent(kind=EventKind.UPDATED, session_id="a")
        threading.Thread(target=broadcaster.publish, args=(event,)).start()
        return await asyncio.wait_for(queue.get(), timeout=2)

    assert asyncio.run(scenario()) == RegistryEvent(kind=EventKind.UPDATED, session_id="a")
