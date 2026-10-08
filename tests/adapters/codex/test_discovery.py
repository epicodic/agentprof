# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from pathlib import Path

from agentprof.adapters.codex.discovery import default_sessions_root, read_metadata, session_files
from agentprof.adapters.codex.rollout import load_rollout

_SESSIONS = Path(__file__).parent / "fixtures/sessions"
_DAY = _SESSIONS / "2026/09/26"
_ROOT = _DAY / "rollout-2026-09-26T10-00-00-root.jsonl"
_AGENT = _DAY / "rollout-2026-09-26T10-00-10-agent.jsonl"
_ORPHAN = _DAY / "rollout-2026-09-26T10-01-00-orphan.jsonl"
_IGNORED = _DAY / "ignored.jsonl"


def test_default_sessions_root_uses_home_codex_sessions(tmp_path: Path) -> None:
    assert default_sessions_root(tmp_path) == tmp_path / ".codex" / "sessions"


def test_session_files_groups_main_agent_and_orphan_rollouts() -> None:
    groups = session_files(_SESSIONS)

    assert len(groups) == 1
    assert groups[0].session_id == "root-session"
    assert groups[0].main == _ROOT
    assert groups[0].files == [_ROOT, _AGENT, _ORPHAN]


def test_session_files_ignores_unrecognized_jsonl() -> None:
    assert len(session_files(_IGNORED.parent)) == 1


def test_load_rollout_counts_malformed_lines_without_crashing() -> None:
    rollout = load_rollout(_IGNORED)

    assert rollout.malformed_lines == 1
    assert rollout.session_id is None


def test_session_files_returns_empty_for_missing_root(tmp_path: Path) -> None:
    assert session_files(tmp_path / "missing") == []


def test_read_metadata_stops_after_valid_session_meta(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    path.write_bytes(
        b'{"type":"session_meta","payload":{"id":"thread-1","session_id":"root-1"}}\n' + b"x" * 9000 + b"\xff"
    )

    metadata = read_metadata(path)

    assert metadata is not None
    assert metadata.session_id == "root-1"
    assert metadata.thread_id == "thread-1"


def test_read_metadata_skips_invalid_utf8_before_session_meta(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    path.write_bytes(b'\xff\n{"type":"session_meta","payload":{"session_id":"root-1"}}\n')

    metadata = read_metadata(path)

    assert metadata is not None
    assert metadata.session_id == "root-1"


def test_read_metadata_stops_after_a_small_header_sniff(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    path.write_text(
        "\n".join([*("not json" for _ in range(20)), '{"type":"session_meta","payload":{"session_id":"root-1"}}']),
        encoding="utf-8",
    )

    assert read_metadata(path) is None
