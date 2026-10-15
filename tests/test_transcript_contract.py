# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Cross-adapter transcript contract: scope, ownership, accounting and stable entry ids through the API."""

import json
import os
import shutil
from collections import Counter
from pathlib import Path
from typing import Any, TypedDict

import pytest
from fastapi.testclient import TestClient

from agentprof.adapters.base import AdapterConfig
from agentprof.adapters.claude_code.adapter import ClaudeCodeAdapter
from agentprof.adapters.codex.adapter import CodexAdapter
from agentprof.adapters.copilot_vscode.adapter import CopilotVscodeAdapter
from agentprof.model import Session, iter_nodes
from agentprof.registry import Registry
from agentprof.server.app import create_app

_FIXTURES = Path(__file__).parent / "adapters"
_LATE_BODY = "x" * 260 + " late ΩMEGA [needle]+ café"
_ARGUMENT_QUERY = "STRUCTURED [ARG]+ Δ"


class _NativeOracle(TypedDict):
    child: str
    grandchild: str
    sequence_owner: str
    tool: str
    sequence_ids: list[str]
    child_marker: str
    grandchild_marker: str
    task: str
    intermediate: str
    result: str
    argument_path: tuple[str, ...]


def _append_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    with path.open("a", encoding="utf-8") as source:
        source.writelines(json.dumps(record, ensure_ascii=False) + "\n" for record in records)


@pytest.fixture(params=("claude", "codex", "copilot"))
def native_transcript_server(
    request: pytest.FixtureRequest, copilot_storage: Path, tmp_path: Path
) -> tuple[TestClient, Registry, str, Session]:
    if request.param == "claude":
        projects = tmp_path / "claude-projects"
        shutil.copytree(_FIXTURES / "claude_code/fixtures/projects", projects)
        child = projects / "-home-user-demo/11111111-1111-4111-8111-111111111111/subagents/agent-aaa.jsonl"
        _append_jsonl(
            child,
            [
                {
                    "type": "user",
                    "uuid": "acceptance-claude-task",
                    "timestamp": "2026-09-20T10:12:00.000Z",
                    "message": {"role": "user", "content": "Claude nested task"},
                },
                {
                    "type": "assistant",
                    "uuid": "acceptance-claude-intermediate",
                    "timestamp": "2026-09-20T10:12:01.000Z",
                    "message": {
                        "role": "assistant",
                        "id": "acceptance-claude-intermediate",
                        "model": "claude-sonnet-5",
                        "usage": {"input_tokens": 1, "output_tokens": 1},
                        "content": [{"type": "text", "text": "CLAUDE_CHILD_ONLY Ω [needle]+"}],
                    },
                },
                {
                    "type": "assistant",
                    "uuid": "acceptance-claude-request-record",
                    "timestamp": "2026-09-20T10:12:02.000Z",
                    "message": {
                        "role": "assistant",
                        "id": "acceptance-claude-request",
                        "model": "claude-sonnet-5",
                        "usage": {"input_tokens": 1, "output_tokens": 1},
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "acceptance-claude-tool",
                                "name": "Read",
                                "input": {"query": _ARGUMENT_QUERY},
                            }
                        ],
                    },
                },
                {
                    "type": "user",
                    "uuid": "acceptance-claude-result",
                    "timestamp": "2026-09-20T10:12:03.000Z",
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "acceptance-claude-tool",
                                "content": "Claude result body",
                            }
                        ],
                    },
                },
                {
                    "type": "assistant",
                    "uuid": "acceptance-claude-final",
                    "timestamp": "2026-09-20T10:12:04.000Z",
                    "message": {
                        "role": "assistant",
                        "id": "acceptance-claude-final",
                        "model": "claude-sonnet-5",
                        "usage": {"input_tokens": 1, "output_tokens": 1},
                        "content": [{"type": "text", "text": _LATE_BODY}],
                    },
                },
            ],
        )
        grandchild = projects / "-home-user-demo/11111111-1111-4111-8111-111111111111/subagents/agent-bbb.jsonl"
        _append_jsonl(
            grandchild,
            [
                {
                    "type": "assistant",
                    "uuid": "acceptance-claude-grandchild-marker",
                    "timestamp": "2026-09-20T10:12:05.000Z",
                    "message": {
                        "role": "assistant",
                        "id": "acceptance-claude-grandchild-marker",
                        "model": "claude-haiku-4-5-20251001",
                        "usage": {"input_tokens": 1, "output_tokens": 1},
                        "content": [{"type": "text", "text": "CLAUDE_GRANDCHILD_ONLY"}],
                    },
                }
            ],
        )
        adapter = ClaudeCodeAdapter(AdapterConfig(roots={"claude-code": projects}))
    elif request.param == "codex":
        sessions = tmp_path / "codex-sessions"
        shutil.copytree(_FIXTURES / "codex/fixtures/sessions", sessions)
        child = sessions / "2026/09/26/rollout-2026-09-26T10-00-10-agent.jsonl"
        _append_jsonl(
            child,
            [
                {
                    "timestamp": "2026-09-26T10:00:11.900Z",
                    "ordinal": 8,
                    "type": "event_msg",
                    "payload": {
                        "type": "task_started",
                        "turn_id": "acceptance-agent-turn",
                        "root_turn_id": "acceptance-agent-turn",
                        "started_at": "2026-09-26T10:00:11.900Z",
                    },
                },
                {
                    "timestamp": "2026-09-26T10:00:12.000Z",
                    "ordinal": 9,
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "id": "acceptance-codex-task",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "Codex nested task"}],
                    },
                },
                {
                    "timestamp": "2026-09-26T10:00:13.000Z",
                    "ordinal": 10,
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "id": "acceptance-codex-intermediate",
                        "role": "assistant",
                        "channel": "commentary",
                        "content": [{"type": "output_text", "text": "CODEX_CHILD_ONLY Ω [needle]+"}],
                    },
                },
                {
                    "timestamp": "2026-09-26T10:00:14.000Z",
                    "ordinal": 11,
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "id": "acceptance-codex-request-record",
                        "call_id": "acceptance-codex-tool",
                        "name": "read_file",
                        "arguments": json.dumps({"query": _ARGUMENT_QUERY}, ensure_ascii=False),
                    },
                },
                {
                    "timestamp": "2026-09-26T10:00:15.000Z",
                    "ordinal": 12,
                    "type": "response_item",
                    "payload": {
                        "type": "function_call_output",
                        "id": "acceptance-codex-result",
                        "call_id": "acceptance-codex-tool",
                        "output": "Codex result body",
                    },
                },
                {
                    "timestamp": "2026-09-26T10:00:16.000Z",
                    "ordinal": 13,
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "id": "acceptance-codex-final",
                        "role": "assistant",
                        "channel": "final",
                        "content": [{"type": "output_text", "text": _LATE_BODY}],
                    },
                },
                {
                    "timestamp": "2026-09-26T10:00:17.000Z",
                    "ordinal": 14,
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "id": "acceptance-codex-delegate",
                        "call_id": "acceptance-codex-delegate-call",
                        "name": "spawn_agent",
                        "arguments": {"task": "Codex grandchild task", "nickname": "AcceptanceGrandchild"},
                    },
                },
                {
                    "timestamp": "2026-09-26T10:00:18.000Z",
                    "ordinal": 15,
                    "type": "response_item",
                    "payload": {
                        "type": "function_call_output",
                        "id": "acceptance-codex-delegate-result",
                        "call_id": "acceptance-codex-delegate-call",
                        "output": "started",
                    },
                },
            ],
        )
        grandchild = sessions / "2026/09/26/rollout-2026-09-26T10-00-20-grandchild.jsonl"
        grandchild.write_text(
            "\n".join(
                json.dumps(record)
                for record in [
                    {
                        "timestamp": "2026-09-26T10:00:20.000Z",
                        "ordinal": 0,
                        "type": "session_meta",
                        "payload": {
                            "id": "grandchild-thread",
                            "session_id": "root-session",
                            "parent_thread_id": "agent-thread",
                            "agent_nickname": "AcceptanceGrandchild",
                            "source": {
                                "subagent": {
                                    "thread_spawn": {
                                        "parent_thread_id": "agent-thread",
                                        "depth": 2,
                                        "agent_path": "acceptance-grandchild",
                                        "agent_nickname": "AcceptanceGrandchild",
                                        "agent_role": "researcher",
                                    }
                                }
                            },
                            "cwd": "/work/demo",
                        },
                    },
                    {
                        "timestamp": "2026-09-26T10:00:21.000Z",
                        "ordinal": 1,
                        "type": "response_item",
                        "payload": {
                            "type": "message",
                            "id": "acceptance-codex-grandchild-marker",
                            "role": "assistant",
                            "channel": "final",
                            "content": [{"type": "output_text", "text": "CODEX_GRANDCHILD_ONLY"}],
                        },
                    },
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        adapter = CodexAdapter(AdapterConfig(roots={"codex": sessions}))
    else:
        transcript = copilot_storage / "hash1/GitHub.copilot-chat/transcripts/session_basic_001.jsonl"
        events = [json.loads(line) for line in transcript.read_text(encoding="utf-8").splitlines()]
        tool_message = next(index for index, event in enumerate(events) if event.get("id") == "e12")
        tool_result = next(index for index, event in enumerate(events) if event.get("id") == "e14")
        events[tool_message]["data"]["content"] = "Copilot child executes its nested task."
        events[tool_message]["data"]["toolRequests"][0]["arguments"] = {"query": _ARGUMENT_QUERY}
        events[tool_message]["parentId"] = "acceptance-copilot-grandchild-intermediate-record"
        events[tool_result]["data"]["output"] = "Copilot result body"
        acceptance_prefix = [
            {
                "type": "user.message",
                "data": {"content": "Copilot nested task", "ownerId": "call_exec"},
                "id": "acceptance-copilot-grandchild-task",
                "timestamp": "2026-09-23T00:00:01.500Z",
                "parentId": "e11",
            },
            {
                "type": "assistant.message",
                "data": {
                    "messageId": "acceptance-copilot-grandchild-intermediate",
                    "ownerId": "call_exec",
                    "content": "Copilot intermediate assistant text",
                },
                "id": "acceptance-copilot-grandchild-intermediate-record",
                "timestamp": "2026-09-23T00:00:01.600Z",
                "parentId": "acceptance-copilot-grandchild-task",
            },
        ]
        events[tool_message:tool_message] = acceptance_prefix
        events.extend(
            [
                {
                    "type": "assistant.message",
                    "data": {
                        "messageId": "acceptance-copilot-grandchild-final",
                        "ownerId": "call_exec",
                        "content": _LATE_BODY,
                    },
                    "id": "acceptance-copilot-grandchild-final-record",
                    "timestamp": "2026-09-23T00:00:01.700Z",
                    "parentId": "e14",
                },
                {
                    "type": "assistant.message",
                    "data": {
                        "messageId": "acceptance-copilot-grandchild-marker",
                        "ownerId": "call_exec",
                        "content": "COPILOT_GRANDCHILD_ONLY",
                    },
                    "id": "acceptance-copilot-grandchild-marker-record",
                    "timestamp": "2026-09-23T00:00:01.800Z",
                    "parentId": "acceptance-copilot-grandchild-final-record",
                },
                {
                    "type": "assistant.message",
                    "data": {
                        "messageId": "acceptance-copilot-child-intermediate",
                        "ownerId": "call_lead",
                        "content": "COPILOT_CHILD_ONLY Ω [needle]+",
                    },
                    "id": "acceptance-copilot-child-intermediate-record",
                    "timestamp": "2026-09-23T00:00:02.000Z",
                },
                {
                    "type": "assistant.message",
                    "data": {
                        "messageId": "acceptance-copilot-child-final",
                        "ownerId": "call_lead",
                        "content": "Copilot child final",
                    },
                    "id": "acceptance-copilot-child-final-record",
                    "timestamp": "2026-09-23T00:00:02.100Z",
                },
            ]
        )
        transcript.write_text(
            "\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n", encoding="utf-8"
        )
        adapter = CopilotVscodeAdapter(AdapterConfig(roots={"copilot-vscode": copilot_storage}))

    registry = Registry([adapter])
    registry.refresh()
    refs = list(adapter.discover())
    assert len(refs) == 1
    ref = refs[0]
    session_id = registry.resolve(str(ref.path))
    while registry.step():
        pass
    session, _ = registry.session(session_id)
    return TestClient(create_app(registry)), registry, session_id, session


def _accounting_signature(session: Session) -> tuple[tuple[object, ...], ...]:
    return tuple(
        (
            node.node_id,
            tuple((call.call_id, call.source_request_id, call.source_stream_id) for call in node.llm_calls),
            tuple((event.event_id, event.kind, event.source_order) for event in node.execution_events),
            node.cost_own.value,
            node.cost_own.unit,
            node.cost_total.value,
            node.cost_total.unit,
        )
        for node in iter_nodes(session.root)
    )


def _detail(client: TestClient, base: str, entry: dict[str, Any]) -> dict[str, Any]:
    response = client.get(f"{base}/transcript/entries/{entry['entry_id']}")
    assert response.status_code == 200
    return response.json()


def _text_blocks(detail: dict[str, Any]) -> list[str]:
    return [block["text"] for block in detail["blocks"] if block["text"] is not None]


def _keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        return set(value) | set().union(*(_keys(item) for item in value.values()))
    if isinstance(value, list):
        return set().union(*(_keys(item) for item in value)) if value else set()
    return set()


def test_native_adapter_transcripts_keep_scope_and_accounting_contract(
    native_transcript_server: tuple[TestClient, Registry, str, Session],
) -> None:
    client, registry, session_id, session = native_transcript_server
    base = f"/api/sessions/{session_id}"
    page_response = client.get(f"{base}/transcript")
    assert page_response.status_code == 200
    page = page_response.json()
    entries = page["entries"]
    assert 0 < len(entries) <= 50
    assert len({entry["entry_id"] for entry in entries}) == len(entries)
    assert all("blocks" not in entry and len(entry["preview"] or "") <= 240 for entry in entries)

    source_prefix = next(
        prefix for prefix in ("claude-code:", "codex:", "copilot-vscode:") if session_id.startswith(prefix)
    )
    native_oracles: dict[str, _NativeOracle] = {
        "claude-code:": {
            "child": "toolu_agent1",
            "grandchild": "toolu_agent2",
            "sequence_owner": "toolu_agent1",
            "tool": "acceptance-claude-tool",
            "sequence_ids": [
                "acceptance-claude-task",
                "acceptance-claude-intermediate",
                "acceptance-claude-request",
                "acceptance-claude-result",
                "acceptance-claude-final",
            ],
            "child_marker": "CLAUDE_CHILD_ONLY Ω [needle]+",
            "grandchild_marker": "CLAUDE_GRANDCHILD_ONLY",
            "task": "Claude nested task",
            "intermediate": "CLAUDE_CHILD_ONLY Ω [needle]+",
            "result": "Claude result body",
            "argument_path": ("input", "query"),
        },
        "codex:": {
            "child": "agent-agent-thread",
            "grandchild": "agent-grandchild-thread",
            "sequence_owner": "agent-agent-thread",
            "tool": "acceptance-codex-tool",
            "sequence_ids": [
                "acceptance-codex-task",
                "acceptance-codex-intermediate",
                "acceptance-codex-request-record",
                "acceptance-codex-result",
                "acceptance-codex-final",
            ],
            "child_marker": "CODEX_CHILD_ONLY Ω [needle]+",
            "grandchild_marker": "CODEX_GRANDCHILD_ONLY",
            "task": "Codex nested task",
            "intermediate": "CODEX_CHILD_ONLY Ω [needle]+",
            "result": "Codex result body",
            "argument_path": ("arguments", "query"),
        },
        "copilot-vscode:": {
            "child": "call_lead",
            "grandchild": "call_exec",
            "sequence_owner": "call_exec",
            "tool": "call_read_child",
            "sequence_ids": [],
            "child_marker": "COPILOT_CHILD_ONLY Ω [needle]+",
            "grandchild_marker": "COPILOT_GRANDCHILD_ONLY",
            "task": "Copilot nested task",
            "intermediate": "Copilot intermediate assistant text",
            "result": "Copilot result body",
            "argument_path": ("query",),
        },
    }
    source = native_oracles[source_prefix]
    child_id = source["child"]
    grandchild_id = source["grandchild"]
    assert isinstance(child_id, str) and isinstance(grandchild_id, str)
    child_scope_response = client.get(f"{base}/transcript", params={"node_id": child_id})
    grandchild_scope_response = client.get(f"{base}/transcript", params={"node_id": grandchild_id})
    main_scope_response = client.get(f"{base}/transcript", params={"node_id": session.root.node_id})
    assert (
        child_scope_response.status_code
        == grandchild_scope_response.status_code
        == main_scope_response.status_code
        == 200
    )
    child_entries = child_scope_response.json()["entries"]
    grandchild_entries = grandchild_scope_response.json()["entries"]
    main_entries = main_scope_response.json()["entries"]
    assert all(entry["owner_id"] == child_id for entry in child_entries)
    assert all(entry["owner_id"] == grandchild_id for entry in grandchild_entries)

    if source_prefix == "copilot-vscode:":
        task_entry = next(
            entry for entry in grandchild_entries if entry["native_id"] == "acceptance-copilot-grandchild-task"
        )
        intermediate_entry = next(
            entry for entry in grandchild_entries if entry["native_id"] == "acceptance-copilot-grandchild-intermediate"
        )
        final_entry = next(
            entry for entry in grandchild_entries if entry["native_id"] == "acceptance-copilot-grandchild-final"
        )
        native_stream = next(
            entry["source_stream_id"] for entry in grandchild_entries if entry["entry_id"] == task_entry["entry_id"]
        )
        transcript_entries = [entry for entry in grandchild_entries if entry["source_stream_id"] == native_stream]
        request_entry = next(
            entry
            for entry in transcript_entries
            if entry["kind"] == "tool_request"
            and _detail(client, base, entry)["blocks"][0]["data"] == {"query": _ARGUMENT_QUERY}
        )
        result_entry = next(entry for entry in transcript_entries if entry["kind"] == "tool_result")
        sequence = [task_entry, intermediate_entry, request_entry, result_entry, final_entry]
    else:
        ids = source["sequence_ids"]
        assert isinstance(ids, list)
        sequence = [
            next((entry for entry in child_entries if entry["native_id"] == native_id), None) for native_id in ids
        ]
        assert all(entry is not None for entry in sequence), (
            f"missing expected native source IDs {ids!r}; got "
            f"{[(entry['native_id'], entry['kind'], entry['preview']) for entry in child_entries]!r}"
        )
        sequence = [entry for entry in sequence if entry is not None]

    sequence_details = [_detail(client, base, entry) for entry in sequence]
    sequence_positions = [
        (detail["source_stream_id"], detail["source_position"], detail["block_position"]) for detail in sequence_details
    ]
    assert len({stream_id for stream_id, _, _ in sequence_positions}) == 1
    assert sequence_positions == sorted(sequence_positions)
    assert [detail["owner_id"] for detail in sequence_details] == [source["sequence_owner"]] * 5
    assert [detail["kind"] for detail in sequence_details] == [
        "user_message",
        "assistant_message",
        "tool_request",
        "tool_result",
        "assistant_message",
    ]
    assert _text_blocks(sequence_details[0]) == [source["task"]]
    assert _text_blocks(sequence_details[1]) == [source["intermediate"]]
    assert _text_blocks(sequence_details[2]) == []
    assert _text_blocks(sequence_details[3]) == [source["result"]]
    late_detail = sequence_details[4]
    assert _text_blocks(late_detail) == [_LATE_BODY]
    assert len(_LATE_BODY) > 240
    late_metadata = next(entry for entry in entries if entry["entry_id"] == late_detail["entry_id"])
    assert len(late_metadata["preview"]) <= 240

    request_detail = sequence_details[2]
    arguments: Any = request_detail["blocks"][0]["data"]
    if source_prefix == "codex:" and isinstance(arguments, dict) and isinstance(arguments.get("arguments"), str):
        arguments = {**arguments, "arguments": json.loads(arguments["arguments"])}
    for key in source["argument_path"]:
        assert isinstance(arguments, dict)
        arguments = arguments[key]
    assert arguments == _ARGUMENT_QUERY
    expected_tool_id = "call_read_child" if source_prefix == "copilot-vscode:" else source["tool"]
    assert request_detail["invocation_id"] == expected_tool_id

    sequence_ids = {detail["entry_id"] for detail in sequence_details}
    child_entry_ids = {entry["entry_id"] for entry in child_entries}
    grandchild_entry_ids = {entry["entry_id"] for entry in grandchild_entries}
    grandchild_marker_entry = next(
        entry for entry in grandchild_entries if source["grandchild_marker"] in (entry["preview"] or "")
    )
    assert child_entry_ids.isdisjoint(grandchild_entry_ids)
    assert sequence_ids.isdisjoint({entry["entry_id"] for entry in main_entries})
    assert len({entry["entry_id"] for entry in entries}) == len(entries)
    all_entry_ids = {entry["entry_id"] for entry in entries}
    assert child_entry_ids <= all_entry_ids
    assert grandchild_entry_ids <= all_entry_ids
    assert sequence_ids <= all_entry_ids
    assert grandchild_marker_entry["entry_id"] in all_entry_ids

    own_turn = next(node for node in session.root.children if node.kind.value == "turn")
    turn_response = client.get(f"{base}/transcript", params={"node_id": own_turn.node_id})
    assert turn_response.status_code == 200
    turn_entries = turn_response.json()["entries"]
    assert turn_entries
    assert all(entry["owner_id"] == own_turn.node_id for entry in turn_entries)
    assert {entry["entry_id"] for entry in turn_entries} <= all_entry_ids

    child_marker = source["child_marker"]
    child_search = client.get(
        f"{base}/transcript/search", params={"q": child_marker.lower(), "node_id": child_id}
    ).json()
    parent_search = client.get(
        f"{base}/transcript/search", params={"q": child_marker.lower(), "node_id": session.root.node_id}
    ).json()
    session_search = client.get(f"{base}/transcript/search", params={"q": child_marker.lower()}).json()
    assert len(child_search["hits"]) == 1
    assert child_search["hits"][0]["owner_id"] == child_id
    assert parent_search["hits"] == []
    assert len(session_search["hits"]) == 1
    assert session_search["hits"][0]["entry_id"] == child_search["hits"][0]["entry_id"]

    late_search = client.get(f"{base}/transcript/search", params={"q": "late ωmega [NEEDLE]+ CAFÉ"}).json()
    assert late_detail["entry_id"] in {hit["entry_id"] for hit in late_search["hits"]}
    argument_search = client.get(f"{base}/transcript/search", params={"q": "structured [arg]+ δ"}).json()
    assert request_detail["entry_id"] in {hit["entry_id"] for hit in argument_search["hits"]}, (
        request_detail["blocks"],
        argument_search,
    )

    tool_scope_response = client.get(f"{base}/transcript", params={"node_id": source["tool"]})
    assert tool_scope_response.status_code == 200, (
        source["tool"],
        [(node.node_id, node.kind.value) for node in iter_nodes(session.root)],
    )
    tool_scope = tool_scope_response.json()["entries"]
    tool_details = [_detail(client, base, entry) for entry in tool_scope]
    assert all(detail["invocation_id"] == source["tool"] for detail in tool_details)
    tool_kinds = Counter(detail["kind"] for detail in tool_details)
    if source_prefix == "copilot-vscode:":
        assert tool_kinds == Counter({"tool_request": 3, "tool_result": 1})
    else:
        assert tool_kinds == Counter({"tool_request": 1, "tool_result": 1})

    session_payload = client.get(base).json()
    summary_payload = client.get(f"{base}/summary").json()
    list_payload = client.get("/api/sessions").json()
    forbidden = {"transcript_entries", "transcript_coverage", "preview", "blocks"}
    assert not (_keys(session_payload) & forbidden)
    assert not (_keys(summary_payload) & forbidden)
    assert not (_keys(list_payload) & forbidden)

    row = registry.row(session_id)
    assert row is not None and row.summary is not None
    assert row.summary.cost_total.value == pytest.approx(session.root.cost_total.value)
    assert (row.summary.cost_total.unit, row.summary.cost_total.provenance) == (
        session.root.cost_total.unit,
        session.root.cost_total.provenance,
    )


def test_copilot_debug_history_and_responses_preserve_physical_file_order(copilot_storage: Path) -> None:
    debug_file = copilot_storage / "hash1/GitHub.copilot-chat/debug-logs/session_basic_001/main.jsonl"
    records = [
        {
            "type": "agent_response",
            "sid": "session_basic_001",
            "spanId": "agent-msg-first",
            "ts": 5_000,
            "attrs": {
                "response": json.dumps([{"role": "assistant", "parts": [{"type": "text", "text": "response first"}]}])
            },
        },
        {
            "type": "llm_request",
            "sid": "call_lead",
            "spanId": "second",
            "ts": 2_000,
            "attrs": {"inputMessages": [{"role": "user", "parts": [{"type": "text", "text": "history second"}]}]},
        },
        {
            "type": "agent_response",
            "sid": "call_lead",
            "spanId": "agent-msg-third",
            "ts": 4_000,
            "attrs": {
                "response": json.dumps([{"role": "assistant", "parts": [{"type": "text", "text": "response third"}]}])
            },
        },
        {
            "type": "llm_request",
            "sid": "session_basic_001",
            "spanId": "fourth",
            "ts": 1_000,
            "attrs": {"inputMessages": [{"role": "user", "parts": [{"type": "text", "text": "history fourth"}]}]},
        },
    ]
    debug_file.write_text("\n".join(json.dumps(record) for record in records) + "\n", encoding="utf-8")
    adapter = CopilotVscodeAdapter(AdapterConfig(roots={"copilot-vscode": copilot_storage}))
    (ref,) = adapter.discover()
    registry = Registry([adapter])
    registry.refresh()
    client = TestClient(create_app(registry))
    session, _ = registry.session(ref.id)
    entries = [
        entry
        for entry in client.get(f"/api/sessions/{ref.id}/transcript").json()["entries"]
        if entry["source_stream_id"].endswith(":main.jsonl") and entry["source_position"] < len(records)
    ]

    assert [entry["source_position"] for entry in entries] == [0, 1, 2, 3]
    assert len({entry["source_stream_id"] for entry in entries}) == 1
    assert [entry["preview"] for entry in entries if entry["preview"] is not None] == [
        "response first",
        "response third",
    ]
    assert [entry["owner_id"] for entry in entries] == [
        session.root.node_id,
        "call_lead",
        "call_lead",
        session.root.node_id,
    ]
    assert [entry["timestamp"]["value"] for entry in entries] == [5_000, 2_000, 4_000, 1_000]
    assert [entry["channel"] for entry in entries if entry["channel"] == "request_history_snapshot"] == [
        "request_history_snapshot",
        "request_history_snapshot",
    ]

    initial_signature = _accounting_signature(session)
    previous_times = debug_file.stat()
    records[0]["attrs"]["response"] = json.dumps(
        [{"role": "assistant", "parts": [{"type": "text", "text": "edited response only"}]}]
    )
    records[1]["attrs"]["inputMessages"][0]["parts"][0]["text"] = "edited history only"
    debug_file.write_text("\n".join(json.dumps(record) for record in records) + "\n", encoding="utf-8")
    os.utime(debug_file, ns=(previous_times.st_atime_ns, previous_times.st_mtime_ns + 2_000_000_000))
    registry.refresh()
    updated_session, _ = registry.session(ref.id)
    assert _accounting_signature(updated_session) == initial_signature


def test_native_claude_append_keeps_prior_entry_ids_through_registry_and_api(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    shutil.copytree(_FIXTURES / "claude_code/fixtures/projects", projects)
    adapter = ClaudeCodeAdapter(AdapterConfig(roots={"claude-code": projects}))
    registry = Registry([adapter])
    registry.refresh()
    (ref,) = adapter.discover()
    client = TestClient(create_app(registry))
    path = f"/api/sessions/{ref.id}/transcript"
    initial_entries = client.get(path).json()["entries"]
    initial_ids = {entry["entry_id"] for entry in initial_entries}
    source = ref.path
    previous_times = source.stat()
    appended = {
        "type": "user",
        "uuid": "increment6-appended-user",
        "timestamp": "2026-10-12T10:00:00.000Z",
        "message": {"role": "user", "content": "appended public synthetic prompt"},
    }
    source.write_text(source.read_text(encoding="utf-8") + json.dumps(appended) + "\n", encoding="utf-8")
    os.utime(source, ns=(previous_times.st_atime_ns, previous_times.st_mtime_ns + 2_000_000_000))
    registry.refresh()

    updated_entries = client.get(path).json()["entries"]
    updated_ids = {entry["entry_id"] for entry in updated_entries}
    appended_entry = next(entry for entry in updated_entries if entry["preview"] == "appended public synthetic prompt")
    assert initial_ids <= updated_ids
    assert appended_entry["source_position"] == max(entry["source_position"] for entry in initial_entries) + 1
    assert appended_entry["source_stream_id"] in {entry["source_stream_id"] for entry in initial_entries}
