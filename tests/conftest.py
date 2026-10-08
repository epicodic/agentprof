# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import json
import shutil
from pathlib import Path

import pytest

_COPILOT_FIXTURES = Path(__file__).parent / "adapters" / "copilot_vscode" / "fixtures"
_COPILOT_SESSION_ID = "session_basic_001"


@pytest.fixture
def copilot_storage(tmp_path: Path) -> Path:
    """A fake `workspaceStorage` root with one live session (`session_basic_001`), its transcript and debug log."""
    storage = tmp_path / "storage"
    workspace = storage / "hash1"
    (workspace / "chatSessions").mkdir(parents=True)
    (workspace / "workspace.json").write_text(json.dumps({"folder": "file:///repo"}))
    shutil.copy(
        _COPILOT_FIXTURES / "live_session_patches.jsonl", workspace / "chatSessions" / f"{_COPILOT_SESSION_ID}.jsonl"
    )
    transcripts = workspace / "GitHub.copilot-chat" / "transcripts"
    transcripts.mkdir(parents=True)
    shutil.copy(_COPILOT_FIXTURES / "transcript_basic.jsonl", transcripts / f"{_COPILOT_SESSION_ID}.jsonl")
    debug_log = workspace / "GitHub.copilot-chat" / "debug-logs" / _COPILOT_SESSION_ID
    debug_log.mkdir(parents=True)
    for source in (_COPILOT_FIXTURES / "debug_log").glob("*.jsonl"):
        (debug_log / source.name).write_text(source.read_text().replace("root_session", _COPILOT_SESSION_ID))
    return storage
