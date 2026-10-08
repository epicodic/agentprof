# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

"""Tests for the Codex adapter protocol implementation."""

import json
import os
import shutil
from pathlib import Path

import pytest

from agentprof.adapters.base import AdapterConfig
from agentprof.adapters.codex.adapter import CodexAdapter
from agentprof.analysis.pipeline import analyze
from agentprof.model import Provenance

_SESSIONS = Path(__file__).parent / "fixtures" / "sessions"
_DAY = _SESSIONS / "2026" / "09" / "26"
_ROOT = _DAY / "rollout-2026-09-26T10-00-00-root.jsonl"
_AGENT = _DAY / "rollout-2026-09-26T10-00-10-agent.jsonl"


def _adapter(root: Path = _SESSIONS) -> CodexAdapter:
    return CodexAdapter(AdapterConfig(roots={"codex": root}))


def test_discover_finds_the_grouped_session() -> None:
    (ref,) = _adapter().discover()

    assert ref.id == "codex:root-session"
    assert ref.path == _ROOT


def test_summarize_reads_the_cheap_fields_and_matches_analysed_cost() -> None:
    adapter = _adapter()
    (ref,) = adapter.discover()

    summary = adapter.summarize(ref)
    session = analyze(adapter, ref)

    assert (summary.title, summary.workspace, summary.start_ms) == (
        "Inspect the demo workspace.",
        "/work/demo",
        1790416800200,
    )
    assert summary.cost_total.value == pytest.approx(session.root.cost_total.value)
    assert summary.last_activity_ms == 1790416860300
    assert summary.cost_total.provenance is Provenance.ESTIMATED


def test_analyze_reports_sources_and_diagnostics(tmp_path: Path) -> None:
    sessions = tmp_path / "sessions"
    shutil.copytree(_SESSIONS, sessions)
    root = sessions / "2026" / "09" / "26" / _ROOT.name
    with root.open("a", encoding="utf-8") as output:
        output.write("not json\n")
        output.write('{"type":"event_msg","payload":{"type":"task_started","turn_id":"unknown-tool-turn"}}\n')
        output.write('{"type":"response_item","payload":{"type":"function_call","name":"new_tool"}}\n')
    adapter = _adapter(sessions)
    (ref,) = adapter.discover()

    session = adapter.analyze(ref)

    assert session.agent == "codex"
    assert session.title == "Inspect the demo workspace."
    assert session.workspace == "/work/demo"
    assert session.sources == ["rollout", "subagents"]
    assert session.diagnostics.malformed_lines == 1
    assert session.diagnostics.unknown_tool_ids == {"new_tool": 1}


def test_open_path_resolves_main_and_subagent_rollouts() -> None:
    adapter = _adapter()

    assert adapter.open_path(_ROOT) is not None
    assert adapter.open_path(_AGENT) is not None
    assert adapter.open_path(_DAY / "ignored.jsonl") is None


def test_ref_mtime_covers_every_grouped_rollout(tmp_path: Path) -> None:
    sessions = tmp_path / "sessions"
    shutil.copytree(_SESSIONS, sessions)
    adapter = _adapter(sessions)
    (before,) = adapter.discover()
    agent = sessions / "2026" / "09" / "26" / _AGENT.name
    newer = before.mtime + 100
    os.utime(agent, (newer, newer))

    (after,) = adapter.discover()

    assert after.mtime == newer


def test_analyze_merges_root_continuation_rollouts_into_turns(tmp_path: Path) -> None:
    sessions = tmp_path / "sessions"
    shutil.copytree(_SESSIONS, sessions)
    continuation = sessions / "2026" / "09" / "26" / "rollout-continuation.jsonl"
    continuation.write_text(
        "\n".join(
            [
                '{"type":"session_meta","payload":{"id":"root-continuation","session_id":"root-session","cwd":"/work/demo"}}',
                '{"type":"turn_context","payload":{"turn_id":"continued-turn","model":"gpt-6-sol"}}',
                '{"timestamp":"2026-09-26T10:02:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"continued-turn"}}',
                json.dumps(
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": "Continue with the real request."}],
                        },
                    }
                ),
                '{"timestamp":"2026-09-26T10:02:01.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"continued-turn"}}',
            ]
        ),
        encoding="utf-8",
    )

    (ref,) = _adapter(sessions).discover()
    session = _adapter(sessions).analyze(ref)

    assert [turn.prompt for turn in session.root.children if turn.kind.value == "turn"] == [
        "Inspect the demo workspace.",
        "Summarize the findings.",
        "Continue with the real request.",
    ]
