# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import json
import os
import shutil
from pathlib import Path

import pytest

from agentprof.adapters.base import AdapterConfig
from agentprof.adapters.claude_code.adapter import ClaudeCodeAdapter
from agentprof.analysis.pipeline import analyze
from agentprof.model import Metric, Provenance

_PROJECTS = Path(__file__).parent / "fixtures" / "projects"
_SESSION_ID = "11111111-1111-4111-8111-111111111111"
_MAIN = _PROJECTS / "-home-user-demo" / f"{_SESSION_ID}.jsonl"
_T0 = 1789898400000


def _adapter(pricing_file: Path | None = None) -> ClaudeCodeAdapter:
    return ClaudeCodeAdapter(AdapterConfig(roots={"claude-code": _PROJECTS}, pricing_file=pricing_file))


def test_discover_finds_the_session() -> None:
    (ref,) = _adapter().discover()

    assert ref.id == f"claude-code:{_SESSION_ID}"
    assert ref.path == _MAIN


def test_summarize_reads_title_workspace_and_cost() -> None:
    adapter = _adapter()
    (ref,) = adapter.discover()

    summary = adapter.summarize(ref)

    assert summary.title == "Fix the parser"
    assert summary.workspace == "/home/user/demo"
    assert summary.start_ms == _T0
    assert summary.last_activity_ms == _T0 + 700000
    assert summary.cost_total.unit == "USD"
    assert summary.cost_total.provenance is Provenance.ESTIMATED  # one model has no price


def test_analyze_reports_sources_and_diagnostics() -> None:
    adapter = _adapter()
    (ref,) = adapter.discover()

    session = adapter.analyze(ref)

    assert session.agent == "claude-code"
    assert session.title == "Fix the parser"
    assert session.workspace == "/home/user/demo"
    assert session.sources == ["transcript", "subagents"]
    assert session.diagnostics.malformed_lines == 1
    assert len(session.diagnostics.malformed_line_details) == 1
    assert session.diagnostics.malformed_line_details[0].source_path == str(_MAIN)
    assert session.diagnostics.malformed_line_details[0].error_category == "invalid_json"
    assert session.diagnostics.unknown_tool_ids == {"FancyNewTool": 1}
    assert session.diagnostics.warnings == ["No price for model 'claude-unknown-9': its cost is unavailable."]


def test_pipeline_rolls_up_usd_costs_and_token_totals() -> None:
    adapter = _adapter()
    (ref,) = adapter.discover()

    session = analyze(adapter, ref)

    first, second = session.root.children
    assert first.cost_total.value == pytest.approx(0.003185)
    assert first.cost_total.provenance is Provenance.ESTIMATED
    assert second.cost_own.value == pytest.approx(0.00024)
    assert session.root.cost_total.value == pytest.approx(0.003545)
    assert session.root.cost_total.unit == "USD"
    assert session.root.tokens_total.input == Metric.exact(240)


def test_a_pricing_file_replaces_the_bundled_prices(tmp_path: Path) -> None:
    path = tmp_path / "prices.json"
    path.write_text(json.dumps({"models": {}}), encoding="utf-8")
    adapter = _adapter(pricing_file=path)
    (ref,) = adapter.discover()

    session = adapter.analyze(ref)

    assert len(session.diagnostics.warnings) == 3  # sonnet, haiku and the unknown model


def test_open_path_accepts_a_main_transcript_only(tmp_path: Path) -> None:
    adapter = _adapter()
    other = tmp_path / "other.jsonl"
    other.write_text('{"foo": 1}\n', encoding="utf-8")

    assert adapter.open_path(_MAIN) is not None
    assert adapter.open_path(_MAIN.parent / _SESSION_ID / "subagents" / "agent-aaa.jsonl") is None
    assert adapter.open_path(other) is None
    assert adapter.open_path(tmp_path / "missing.jsonl") is None


def test_ref_mtime_covers_subagent_files(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    shutil.copytree(_PROJECTS, projects)
    adapter = ClaudeCodeAdapter(AdapterConfig(roots={"claude-code": projects}))
    (before,) = adapter.discover()
    subagent = projects / "-home-user-demo" / _SESSION_ID / "subagents" / "agent-bbb.jsonl"
    newer = before.mtime + 100
    os.utime(subagent, (newer, newer))

    (after,) = adapter.discover()

    assert after.mtime == newer
