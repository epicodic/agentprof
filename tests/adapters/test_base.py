# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import os
from pathlib import Path

from agentprof.adapters.base import latest_mtime


def test_latest_mtime_is_the_newest_of_all_paths(tmp_path: Path) -> None:
    old, new = tmp_path / "old", tmp_path / "new"
    old.write_text("a")
    new.write_text("b")
    os.utime(old, (100.0, 100.0))
    os.utime(new, (200.0, 200.0))

    assert latest_mtime([old, new]) == 200.0


def test_latest_mtime_ignores_missing_paths(tmp_path: Path) -> None:
    existing = tmp_path / "a"
    existing.write_text("a")
    os.utime(existing, (100.0, 100.0))

    assert latest_mtime([existing, tmp_path / "missing"]) == 100.0
    assert latest_mtime([]) == 0.0
