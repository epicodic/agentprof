# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from pathlib import Path

import pytest

from agentprof_qa.smoke import SmokeError, find_wheel, venv_executable


def test_find_wheel_returns_the_single_agentprof_wheel(tmp_path: Path) -> None:
    wheel = tmp_path / "agentprof-0.1.0-py3-none-any.whl"
    wheel.write_bytes(b"")
    (tmp_path / "agentprof-0.1.0.tar.gz").write_bytes(b"")

    assert find_wheel(tmp_path) == wheel


def test_find_wheel_rejects_zero_or_several_wheels(tmp_path: Path) -> None:
    with pytest.raises(SmokeError, match="found 0"):
        find_wheel(tmp_path)
    (tmp_path / "agentprof-0.1.0-py3-none-any.whl").write_bytes(b"")
    (tmp_path / "agentprof-0.2.0-py3-none-any.whl").write_bytes(b"")
    with pytest.raises(SmokeError, match="found 2"):
        find_wheel(tmp_path)


def test_venv_executable_follows_the_platform_layout(tmp_path: Path) -> None:
    assert venv_executable(tmp_path, "agentprof", "linux") == tmp_path / "bin" / "agentprof"
    assert venv_executable(tmp_path, "agentprof", "win32") == tmp_path / "Scripts" / "agentprof.exe"
