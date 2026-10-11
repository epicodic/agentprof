# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Cross-adapter cache reconciliation using public synthetic source records."""

import json
from pathlib import Path

import pytest

from agentprof.adapters.base import AdapterConfig
from agentprof.adapters.claude_code.adapter import ClaudeCodeAdapter
from agentprof.adapters.codex.adapter import CodexAdapter
from agentprof.adapters.copilot_vscode.adapter import CopilotVscodeAdapter
from agentprof.analysis.pipeline import analyze
from agentprof.model import Provenance, iter_nodes
from agentprof.server.schemas import session_out

_FIXTURES = Path(__file__).parent / "adapters"


def test_claude_cache_ttl_quantities_and_category_costs_reconcile() -> None:
    adapter = ClaudeCodeAdapter(AdapterConfig(roots={"claude-code": _FIXTURES / "claude_code/fixtures/projects"}))
    (ref,) = adapter.discover()
    session = analyze(adapter, ref)
    calls = [call for node in iter_nodes(session.root) for call in node.llm_calls]
    writes = [call for call in calls if call.tokens.cache_write_5m.value is not None]
    assert writes
    for call in writes:
        assert call.tokens.cache_write.number() == (
            call.tokens.cache_write_5m.number() + call.tokens.cache_write_1h.number()
        )
        assert call.cost_parts["cache_read"].unit == "USD"
        assert call.cost_parts["cache_read"].provenance is Provenance.ESTIMATED
    assert session.root.tokens_total.cache_read.number() == sum(call.tokens.cache_read.number() for call in calls)
    payload = session_out(session, ref.mtime)
    assert payload.root.tokens_total.cache_read.value == session.root.tokens_total.cache_read.value


def test_codex_cache_quantities_have_no_fabricated_ttl_or_recorded_billing() -> None:
    adapter = CodexAdapter(AdapterConfig(roots={"codex": _FIXTURES / "codex/fixtures/sessions"}))
    (ref,) = adapter.discover()
    session = analyze(adapter, ref)
    calls = [call for node in iter_nodes(session.root) for call in node.llm_calls]
    assert calls
    assert sum(call.tokens.cache_read.number() for call in calls) == session.root.tokens_total.cache_read.number()
    for call in calls:
        assert call.tokens.cache_write_5m.value is None
        assert call.tokens.cache_write_1h.value is None
        assert call.cost_parts["cache_write_5m"].value is None
        assert call.cost_parts["cache_write_1h"].value is None
        assert call.cost.unit == "USD"
        assert call.cost.provenance is Provenance.ESTIMATED
    assert adapter.summarize(ref).cost_total.value == pytest.approx(session.root.cost_total.value)


def test_copilot_cache_reads_and_recorded_credits_stay_separate(copilot_storage: Path) -> None:
    debug = copilot_storage / "hash1/GitHub.copilot-chat/debug-logs/session_basic_001/main.jsonl"
    records = [json.loads(line) for line in debug.read_text().splitlines()]
    request = next(record for record in records if record["type"] == "llm_request")
    request["attrs"]["copilotUsageNanoAiu"] = 2_000_000_000
    debug.write_text("\n".join(json.dumps(record) for record in records))
    adapter = CopilotVscodeAdapter(AdapterConfig(roots={"copilot-vscode": copilot_storage}))
    (ref,) = adapter.discover()
    session = analyze(adapter, ref)
    call = session.root.children[0].llm_calls[0]
    assert call.tokens.cache_read.value == 12_000
    assert call.tokens.input.value == 28_000
    assert call.tokens.cache_write.value is None
    assert call.tokens.cache_write_5m.value is None
    assert call.tokens.cache_write_1h.value is None
    assert call.cost_parts == {}
    assert call.cost.value == 2
    assert call.cost.unit == "credits"
    assert call.cost.usd == pytest.approx(0.02)
    assert call.cost.provenance is Provenance.EXACT
    assert adapter.summarize(ref).cost_total.value == pytest.approx(session.root.cost_total.value)


def test_codex_long_gap_finding_links_both_source_calls(tmp_path: Path) -> None:
    source = _FIXTURES / "codex/fixtures/sessions/2026/09/26/rollout-2026-09-26T10-00-00-root.jsonl"
    records = [json.loads(line) for line in source.read_text().splitlines()]
    later = next(record for record in records if record["type"] == "token_usage_record")
    later = json.loads(json.dumps(later))
    later["timestamp"] = "2026-09-26T10:10:04.000Z"
    later["payload"]["response_id"] = "later-response"
    records.append(later)
    rollout = tmp_path / "rollout.jsonl"
    rollout.write_text("\n".join(json.dumps(record) for record in records))
    adapter = CodexAdapter(AdapterConfig(roots={"codex": tmp_path}))
    ref = adapter.open_path(rollout)
    assert ref is not None
    session = analyze(adapter, ref)
    gaps = [finding for node in iter_nodes(session.root) for finding in node.findings if finding.heuristic_id == "E6"]
    assert gaps
    assert len([reference for reference in gaps[-1].references if reference.kind == "call"]) == 2
    assert gaps[-1].estimated_avoidable_cost.value is None


def test_codex_recorded_compaction_is_inspectable_without_adjacent_calls(tmp_path: Path) -> None:
    records = [
        {
            "type": "session_meta",
            "payload": {"id": "compact-session", "session_id": "compact-session", "model": "gpt-6-sol"},
        },
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "compact-turn"}},
        {
            "type": "response_item",
            "timestamp": "2026-09-26T10:00:01.000Z",
            "payload": {"type": "compaction", "id": "compact-source", "encrypted_content": "synthetic"},
        },
    ]
    source = tmp_path / "rollout.jsonl"
    source.write_text("\n".join(json.dumps(record) for record in records))
    adapter = CodexAdapter(AdapterConfig(roots={"codex": tmp_path}))
    ref = adapter.open_path(source)
    assert ref is not None
    payload = session_out(analyze(adapter, ref), ref.mtime)
    turn = payload.root.children[0]
    compaction = next(finding for finding in turn.findings if finding.heuristic_id == "E7")
    assert compaction.evidence["provenance"] == "exact"
    assert any(reference.kind == "event" and reference.key == "compact-source" for reference in compaction.references)
    assert compaction.estimated_avoidable_cost.value is None


def test_codex_missing_pricing_categories_do_not_create_a_charge(tmp_path: Path) -> None:
    records = [
        {"type": "session_meta", "payload": {"id": "partial", "session_id": "partial", "model": "gpt-6-sol"}},
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "partial-turn"}},
        {"type": "token_usage_record", "payload": {"turn_id": "partial-turn", "usage": {"input_tokens": 1_000_000}}},
    ]
    source = tmp_path / "rollout.jsonl"
    source.write_text("\n".join(json.dumps(record) for record in records))
    adapter = CodexAdapter(AdapterConfig(roots={"codex": tmp_path}))
    ref = adapter.open_path(source)
    assert ref is not None
    session = analyze(adapter, ref)
    call = session.root.children[0].llm_calls[0]
    assert call.cost.value is None
    assert session.root.cost_total.value is None
    assert adapter.summarize(ref).cost_total.value is None
