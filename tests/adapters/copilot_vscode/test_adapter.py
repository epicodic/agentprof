# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import json
import os
import shutil
from pathlib import Path

from agentprof.adapters.base import AdapterConfig
from agentprof.adapters.copilot_vscode.adapter import CopilotVscodeAdapter
from agentprof.model import NodeKind

_FIXTURES = Path(__file__).parent / "fixtures"


def _adapter(root: Path) -> CopilotVscodeAdapter:
    return CopilotVscodeAdapter(AdapterConfig(roots={"copilot-vscode": root}))


def test_discover_finds_the_live_session(copilot_storage: Path) -> None:
    (ref,) = _adapter(copilot_storage).discover()

    assert ref.id == "copilot-vscode:session_basic_001"
    assert ref.agent == "copilot-vscode"
    assert ref.path.name == "session_basic_001.jsonl"


def test_summarize_reads_the_cheap_fields(copilot_storage: Path) -> None:
    adapter = _adapter(copilot_storage)
    (ref,) = adapter.discover()

    summary = adapter.summarize(ref)

    assert summary.id == ref.id
    assert summary.agent == "copilot-vscode"
    assert summary.title == "session_basic_001"  # no custom title: falls back to the session id
    assert summary.workspace == "/repo"
    assert summary.file_size == ref.path.stat().st_size
    assert summary.end_ms == ref.mtime * 1000
    assert summary.last_activity_ms == 1790123020238
    assert summary.cost_total.unit == "credits"


def test_analyze_joins_all_sources(copilot_storage: Path) -> None:
    adapter = _adapter(copilot_storage)
    (ref,) = adapter.discover()

    session = adapter.analyze(ref)

    assert session.id == ref.id
    assert session.agent == "copilot-vscode"
    assert session.title == "do the thing"
    assert session.workspace == "/repo"
    assert session.sources == ["live-session", "transcript", "debug-log"]
    assert session.diagnostics.warnings == []
    assert [child.kind for child in session.root.children] == [NodeKind.TURN]
    lead = session.root.children[0].children[1]
    assert lead.node_id == "call_lead"
    assert len(lead.llm_calls) == 1


def test_analyze_warns_about_missing_side_files(copilot_storage: Path) -> None:
    shutil.rmtree(copilot_storage / "hash1" / "GitHub.copilot-chat")
    adapter = _adapter(copilot_storage)
    (ref,) = adapter.discover()

    session = adapter.analyze(ref)

    assert session.sources == ["live-session"]
    assert len(session.diagnostics.warnings) == 2


def test_open_path_accepts_an_export_and_finds_its_side_files_by_session_id(
    copilot_storage: Path, tmp_path: Path
) -> None:
    export = tmp_path / "my-export.json"
    shutil.copy(_FIXTURES / "export_basic.json", export)
    adapter = _adapter(copilot_storage)

    ref = adapter.open_path(export)

    assert ref is not None
    assert ref.id == "copilot-vscode:session_basic_001"
    assert adapter.summarize(ref).last_activity_ms == 1790123020238
    session = adapter.analyze(ref)
    assert session.sources == ["export", "transcript", "debug-log"]
    assert session.workspace is None


def test_open_path_accepts_a_live_session_file(copilot_storage: Path) -> None:
    path = copilot_storage / "hash1" / "chatSessions" / "session_basic_001.jsonl"

    ref = _adapter(copilot_storage).open_path(path)

    assert ref is not None
    assert ref.native_id == "session_basic_001"


def test_open_path_rejects_unrelated_files(copilot_storage: Path, tmp_path: Path) -> None:
    unrelated_json = tmp_path / "other.json"
    unrelated_json.write_text(json.dumps({"foo": 1}))
    text_file = tmp_path / "notes.txt"
    text_file.write_text("hello")
    adapter = _adapter(copilot_storage)

    assert adapter.open_path(unrelated_json) is None
    assert adapter.open_path(text_file) is None
    assert adapter.open_path(tmp_path / "missing.json") is None


def test_analyze_counts_unknown_tool_ids(copilot_storage: Path, tmp_path: Path) -> None:
    data = json.loads((_FIXTURES / "export_basic.json").read_text())
    data["requests"][0]["response"][0]["toolId"] = "weird_tool"
    export = tmp_path / "export.json"
    export.write_text(json.dumps(data))
    adapter = _adapter(copilot_storage)
    ref = adapter.open_path(export)
    assert ref is not None

    session = adapter.analyze(ref)

    assert session.diagnostics.unknown_tool_ids == {"weird_tool": 1}


def test_ref_mtime_covers_transcript_and_debug_log(copilot_storage: Path) -> None:
    adapter = _adapter(copilot_storage)
    (before,) = adapter.discover()
    debug_log = copilot_storage / "hash1" / "GitHub.copilot-chat" / "debug-logs" / "session_basic_001"
    newer = before.mtime + 100
    os.utime(next(debug_log.glob("*.jsonl")), (newer, newer))

    (after,) = adapter.discover()

    assert after.mtime == newer
