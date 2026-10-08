# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Smoke-test a built agentprof wheel in a fresh virtual environment.

Run: `uv run smoke [DIST_DIR]` from the repository root (default `dist`).
"""

import argparse
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

_FIXTURE_PROJECTS = Path("tests/adapters/claude_code/fixtures/projects")
_FIXTURE_SESSION = "claude-code:11111111-1111-4111-8111-111111111111"
_STARTUP_TIMEOUT_S = 60.0
_STOP_TIMEOUT_S = 10.0


class SmokeError(Exception):
    """The wheel did not pass the smoke test."""


def find_wheel(dist: Path) -> Path:
    wheels = sorted(dist.glob("agentprof-*.whl"))
    if len(wheels) != 1:
        raise SmokeError(f"expected exactly one agentprof wheel in {dist}, found {len(wheels)}")
    return wheels[0]


def venv_executable(venv: Path, name: str, platform: str = sys.platform) -> Path:
    if platform == "win32":
        return venv / "Scripts" / f"{name}.exe"
    return venv / "bin" / name


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    print(f"$ {' '.join(command)}", flush=True)
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise SmokeError(f"{' '.join(command)} failed ({result.returncode}):\n{result.stdout}{result.stderr}")
    return result


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _get(url: str) -> str:
    with urllib.request.urlopen(url, timeout=5) as response:
        return response.read().decode("utf-8")


def _wait_until_serving(url: str, server: subprocess.Popen[str]) -> None:
    deadline = time.monotonic() + _STARTUP_TIMEOUT_S
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise SmokeError(f"agentprof exited early with code {server.returncode}")
        try:
            _get(url)
            return
        except (urllib.error.URLError, ConnectionError):
            time.sleep(0.2)
    raise SmokeError(f"agentprof did not serve {url} within {_STARTUP_TIMEOUT_S:.0f}s")


def _check_server(agentprof: Path, fixtures: Path, empty_root: Path) -> None:
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    command = [str(agentprof), "--no-browser", "--port", str(port)]
    command += ["--claude-root", str(fixtures), "--copilot-root", str(empty_root)]
    print(f"$ {' '.join(command)}", flush=True)
    server = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        _wait_until_serving(f"{base}/api/sessions", server)
        sessions = _get(f"{base}/api/sessions")
        if _FIXTURE_SESSION not in sessions:
            raise SmokeError(f"/api/sessions does not list the fixture session: {sessions[:200]}")
        index = _get(f"{base}/")
        if 'id="root"' not in index:
            raise SmokeError("/ does not serve the built frontend (the assets are missing from the wheel?)")
    finally:
        server.terminate()
        try:
            server.wait(timeout=_STOP_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()


def smoke_test(wheel: Path, fixtures: Path = _FIXTURE_PROJECTS) -> None:
    """Install `wheel` into a fresh venv, then check `--help` and a server run against the test fixtures."""
    with tempfile.TemporaryDirectory(prefix="agentprof-smoke-") as tmp:
        venv = Path(tmp) / "venv"
        _run(["uv", "venv", "--python", sys.executable, str(venv)])
        python = venv_executable(venv, "python")
        _run(["uv", "pip", "install", "--python", str(python), str(wheel)])
        agentprof = venv_executable(venv, "agentprof")
        if "usage: agentprof" not in _run([str(agentprof), "--help"]).stdout:
            raise SmokeError("agentprof --help printed no usage line")
        _check_server(agentprof, fixtures.resolve(), Path(tmp) / "no-copilot-sessions")
    print(f"smoke test passed: {wheel.name}", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="smoke", description=__doc__)
    parser.add_argument("dist", nargs="?", type=Path, default=Path("dist"), help="directory with the built wheel")
    args = parser.parse_args(argv)
    try:
        smoke_test(find_wheel(args.dist))
    except SmokeError as error:
        print(f"smoke test failed: {error}", file=sys.stderr)
        return 1
    return 0
