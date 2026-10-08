# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import json
import signal
import socket
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from agentprof.adapters import load_adapters
from agentprof.adapters.base import AdapterConfig
from agentprof.cli import _serve, browser_url, is_loopback, main
from agentprof.registry import Registry
from agentprof.server.app import create_app

_CLAUDE_PROJECTS = Path(__file__).parent / "adapters" / "claude_code" / "fixtures" / "projects"
_CODEX_SESSIONS = Path(__file__).parent / "adapters" / "codex" / "fixtures" / "sessions"
_SESSION_ID = "claude-code:11111111-1111-4111-8111-111111111111"
_MAIN = _CLAUDE_PROJECTS / "-home-user-demo" / "11111111-1111-4111-8111-111111111111.jsonl"


class _Recorder:
    def __init__(self) -> None:
        self.served: list[tuple[str, int]] = []
        self.opened: list[str] = []

    def serve(self, app: FastAPI, host: str, port: int, on_started: Callable[[], None]) -> None:
        self.served.append((host, port))
        with TestClient(app):  # runs the lifespan, like a real server start
            on_started()

    def open_browser(self, url: str) -> None:
        self.opened.append(url)


def _run(recorder: _Recorder, copilot_storage: Path, *args: str) -> int:
    roots = [
        "--claude-root",
        str(_CLAUDE_PROJECTS),
        "--codex-root",
        str(_CODEX_SESSIONS),
        "--copilot-root",
        str(copilot_storage),
    ]
    return main([*roots, *args], serve=recorder.serve, open_browser=recorder.open_browser)


def test_main_serves_and_opens_the_session_list(copilot_storage: Path) -> None:
    recorder = _Recorder()

    assert _run(recorder, copilot_storage) == 0

    assert recorder.served == [("127.0.0.1", 8765)]
    assert recorder.opened == ["http://127.0.0.1:8765/"]


def test_main_opens_a_resolved_session(copilot_storage: Path) -> None:
    recorder = _Recorder()

    assert _run(recorder, copilot_storage, "11111111-1111-4111-8111-111111111111", "--port", "9000") == 0

    assert recorder.opened == ["http://127.0.0.1:9000/sessions/claude-code%3A11111111-1111-4111-8111-111111111111"]


def test_main_accepts_a_session_file_path(copilot_storage: Path) -> None:
    recorder = _Recorder()

    assert _run(recorder, copilot_storage, str(_MAIN)) == 0

    assert recorder.opened[0].endswith("claude-code%3A11111111-1111-4111-8111-111111111111")


def test_main_accepts_a_codex_session_file_path(copilot_storage: Path) -> None:
    recorder = _Recorder()
    rollout = _CODEX_SESSIONS / "2026" / "09" / "26" / "rollout-2026-09-26T10-00-10-agent.jsonl"

    assert _run(recorder, copilot_storage, str(rollout)) == 0

    assert recorder.opened[0].endswith("codex%3Aroot-session")


def test_main_rejects_an_unknown_session(copilot_storage: Path, capsys: pytest.CaptureFixture[str]) -> None:
    recorder = _Recorder()

    assert _run(recorder, copilot_storage, "nope") == 2

    assert "unknown session 'nope'" in capsys.readouterr().err
    assert recorder.served == []


def test_main_can_skip_the_browser(copilot_storage: Path) -> None:
    recorder = _Recorder()

    _run(recorder, copilot_storage, "--no-browser")

    assert recorder.opened == []


def test_main_warns_when_serving_beyond_loopback(copilot_storage: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _run(_Recorder(), copilot_storage, "--host", "0.0.0.0", "--no-browser")

    assert "without authentication" in capsys.readouterr().err


def test_main_rejects_an_unreadable_price_file(
    copilot_storage: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert _run(_Recorder(), copilot_storage, "--pricing", str(tmp_path / "missing.json")) == 2

    assert "error:" in capsys.readouterr().err


def test_main_serves_the_price_file_selected_by_cli(copilot_storage: Path, tmp_path: Path) -> None:
    price_file = tmp_path / "pricing.json"
    price_file.write_text(
        json.dumps(
            {
                "source": "CLI override",
                "date": "2026-10-02",
                "models": {
                    "example": {"input": 1, "output": 2, "cache_read": 3, "cache_write_5m": 4, "cache_write_1h": 5}
                },
            }
        )
    )
    captured: list[dict[str, object]] = []

    def serve(app: FastAPI, host: str, port: int, on_started: Callable[[], None]) -> None:
        with TestClient(app) as client:
            captured.append(client.get("/api/pricing").json())

    roots = ["--claude-root", str(_CLAUDE_PROJECTS), "--copilot-root", str(copilot_storage)]

    assert main([*roots, "--pricing", str(price_file), "--no-browser"], serve=serve) == 0
    assert captured[0]["source"] == "CLI override"
    assert captured[0]["date"] == "2026-10-02"
    assert captured[0]["models"] == {
        "example": {"input": 1, "output": 2, "cache_read": 3, "cache_write_5m": 4, "cache_write_1h": 5}
    }


def test_is_loopback() -> None:
    assert is_loopback("127.0.0.1")
    assert is_loopback("localhost")
    assert is_loopback("::1")
    assert not is_loopback("0.0.0.0")
    assert not is_loopback("example.org")


def test_browser_url_uses_localhost_for_wildcard_hosts() -> None:
    assert browser_url("0.0.0.0", 8765, None) == "http://localhost:8765/"
    assert browser_url("127.0.0.1", 1, "a:b") == "http://127.0.0.1:1/sessions/a%3Ab"


def test_main_reports_a_port_that_cannot_be_bound(copilot_storage: Path, capsys: pytest.CaptureFixture[str]) -> None:
    def busy(app: FastAPI, host: str, port: int, on_started: Callable[[], None]) -> None:
        raise OSError("address already in use")

    roots = ["--claude-root", str(_CLAUDE_PROJECTS), "--copilot-root", str(copilot_storage)]
    assert main([*roots, "--no-browser"], serve=busy, open_browser=lambda url: None) == 2

    assert "cannot serve on 127.0.0.1:8765" in capsys.readouterr().err


def test_serve_calls_on_started_only_once_the_port_accepts_connections(copilot_storage: Path) -> None:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    registry = Registry(load_adapters(AdapterConfig(roots={"copilot-vscode": copilot_storage})))
    app = create_app(registry)
    outcome: list[bool] = []

    def on_started() -> None:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=2).close()
            outcome.append(True)
        except OSError:
            outcome.append(False)
        signal.raise_signal(signal.SIGINT)

    _serve(app, "127.0.0.1", port, on_started)

    assert outcome == [True]
