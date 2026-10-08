# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import json
from pathlib import Path
from typing import Any

from agentprof.adapters.copilot_vscode.discovery import (
    SideFiles,
    default_storage_roots,
    find_side_files,
    read_session_state,
    session_files,
    side_files_in_workspace,
    workspace_folder,
)


def _write_live_session(
    workspace_dir: Path, session_id: str, snapshot: dict[str, Any], patches: list[dict[str, Any]]
) -> Path:
    sessions_dir = workspace_dir / "chatSessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps({"kind": 0, "v": snapshot})] + [json.dumps(patch) for patch in patches]
    path = sessions_dir / f"{session_id}.jsonl"
    path.write_text("\n".join(lines) + "\n")
    return path


def _add_side_files(workspace_dir: Path, session_id: str) -> None:
    transcripts = workspace_dir / "GitHub.copilot-chat" / "transcripts"
    transcripts.mkdir(parents=True)
    (transcripts / f"{session_id}.jsonl").write_text("")
    (workspace_dir / "GitHub.copilot-chat" / "debug-logs" / session_id).mkdir(parents=True)


def test_workspace_folder_reads_the_folder_uri(tmp_path: Path) -> None:
    (tmp_path / "workspace.json").write_text(json.dumps({"folder": "file:///repo-a"}))

    assert workspace_folder(tmp_path) == "/repo-a"


def test_workspace_folder_is_none_without_workspace_json(tmp_path: Path) -> None:
    assert workspace_folder(tmp_path) is None


def test_read_session_state_reads_requests_and_title_that_arrive_via_patches(tmp_path: Path) -> None:
    path = _write_live_session(
        tmp_path,
        "sid",
        {"creationDate": 1_000, "requests": []},
        [
            {"kind": 2, "k": ["requests"], "v": [{"requestId": "r1"}]},
            {"kind": 2, "k": ["requests"], "v": [{"requestId": "r2"}]},
            {"kind": 1, "k": ["requests", 0, "modelState"], "v": {"value": 1}},
            {"kind": 1, "k": ["customTitle"], "v": "Patched title"},
        ],
    )

    state = read_session_state(path)

    assert state is not None
    assert state.credits == [None, None]
    assert state.title == "Patched title"
    assert state.created_ms == 1_000


def test_read_session_state_follows_the_credits_of_every_request(tmp_path: Path) -> None:
    path = _write_live_session(
        tmp_path,
        "sid",
        {"requests": [{"requestId": "r1", "copilotCredits": 1.5}]},
        [
            {"kind": 2, "k": ["requests"], "v": [{"requestId": "r2"}, {"requestId": "r3", "copilotCredits": 3.0}]},
            {"kind": 1, "k": ["requests", 1, "copilotCredits"], "v": 2.0},
            {"kind": 1, "k": ["requests", 1, "copilotCredits"], "v": 2.5},
            {"kind": 2, "k": ["requests"], "i": 2, "v": [{"requestId": "r3"}]},
            {"kind": 1, "k": ["requests", 9, "copilotCredits"], "v": 9.0},
        ],
    )

    state = read_session_state(path)

    assert state is not None
    assert state.credits == [1.5, 2.5, None]


def test_read_session_state_takes_the_credits_of_replaced_requests(tmp_path: Path) -> None:
    path = _write_live_session(
        tmp_path,
        "sid",
        {"requests": [{"requestId": "r1", "copilotCredits": 1.5}]},
        [{"kind": 1, "k": ["requests"], "v": [{"requestId": "r9", "copilotCredits": 4.0}]}],
    )

    state = read_session_state(path)

    assert state is not None
    assert state.credits == [4.0]


def test_read_session_state_tracks_latest_message_through_request_patches(tmp_path: Path) -> None:
    path = _write_live_session(
        tmp_path,
        "sid",
        {"requests": [{"timestamp": 100, "responseTimestamp": 120}]},
        [
            {"kind": 2, "k": ["requests"], "v": [{"timestamp": 200}]},
            {"kind": 1, "k": ["requests", 1, "responseTimestamp"], "v": 230},
            {"kind": 1, "k": ["requests", 0, "responseTimestamp"], "v": 150},
        ],
    )

    state = read_session_state(path)

    assert state is not None
    assert state.last_activity_ms == 230


def test_read_session_state_is_none_for_a_malformed_file(tmp_path: Path) -> None:
    path = tmp_path / "broken.jsonl"
    path.write_text("not valid json\n")

    assert read_session_state(path) is None


def test_side_files_in_workspace_finds_transcript_and_debug_log(tmp_path: Path) -> None:
    _add_side_files(tmp_path, "sid")

    side = side_files_in_workspace(tmp_path, "sid")

    assert side.transcript_file == tmp_path / "GitHub.copilot-chat" / "transcripts" / "sid.jsonl"
    assert side.debug_log_dir == tmp_path / "GitHub.copilot-chat" / "debug-logs" / "sid"


def test_side_files_in_workspace_are_none_when_missing(tmp_path: Path) -> None:
    assert side_files_in_workspace(tmp_path, "sid") == SideFiles(transcript_file=None, debug_log_dir=None)


def test_find_side_files_searches_every_workspace_under_every_root(tmp_path: Path) -> None:
    (tmp_path / "root-a" / "hash1").mkdir(parents=True)
    _add_side_files(tmp_path / "root-b" / "hash2", "sid")

    side = find_side_files([tmp_path / "root-a", tmp_path / "root-b", tmp_path / "missing"], "sid")

    assert side.transcript_file is not None
    assert side.debug_log_dir is not None


def test_session_files_lists_live_sessions_of_all_workspaces(tmp_path: Path) -> None:
    first = _write_live_session(tmp_path / "hash1", "sid-1", {"requests": []}, [])
    second = _write_live_session(tmp_path / "hash2", "sid-2", {"requests": []}, [])

    assert session_files(tmp_path) == [first, second]


def test_default_storage_roots_per_platform(tmp_path: Path) -> None:
    home = tmp_path / "home"
    appdata = tmp_path / "appdata"

    assert default_storage_roots("linux", home, None) == [
        home / ".config" / "Code" / "User" / "workspaceStorage",
        home / ".config" / "Code - Insiders" / "User" / "workspaceStorage",
    ]
    assert default_storage_roots("darwin", home, None)[0] == (
        home / "Library" / "Application Support" / "Code" / "User" / "workspaceStorage"
    )
    assert default_storage_roots("win32", home, appdata)[0] == appdata / "Code" / "User" / "workspaceStorage"
    assert default_storage_roots("win32", home, None) == []
