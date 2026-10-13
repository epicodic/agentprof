# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from pathlib import Path

from agentprof_qa.bench import METRICS, measure, write_session


def test_write_session_reaches_the_target_size(tmp_path: Path) -> None:
    projects = write_session(tmp_path, target_bytes=100_000)

    (session_file,) = projects.rglob("*.jsonl")
    assert session_file.stat().st_size >= 100_000


def test_measure_reports_every_metric_for_a_small_session(tmp_path: Path) -> None:
    metrics = measure(write_session(tmp_path, target_bytes=100_000), repeats=1)

    assert list(metrics) == list(METRICS)
    assert all(value >= 0 for value in metrics.values())
