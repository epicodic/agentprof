# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Measure agentprof on a generated large Claude Code session.

Run: `uv run bench` (50 MB) or `uv run bench --size-mb 5`.
Prints a Markdown table: summarize and analyse time and peak memory, and the latency of the session, node and
transcript requests once the analysis is cached.
"""

import argparse
import json
import statistics
import tempfile
import time
import tracemalloc
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from agentprof.adapters.base import AdapterConfig
from agentprof.adapters.claude_code.adapter import ClaudeCodeAdapter
from agentprof.analysis.pipeline import analyze
from agentprof.registry import Registry
from agentprof.server.app import create_app

_SESSION_ID = "bench000-0000-4000-8000-000000000000"
_PROJECT = "-home-user-bench"
_T0 = datetime(2026, 9, 20, 10, 0, 0, tzinfo=UTC)
_RESULT_LINES = 200
_NEEDLE_EVERY = 100

METRICS = {
    "summarize_s": "summarize time (s)",
    "summarize_peak_mb": "summarize peak memory (MB)",
    "analyze_s": "analyse time (s)",
    "analyze_peak_mb": "analyse peak memory (MB)",
    "session_ms": "GET session, cached (ms)",
    "node_ms": "GET node, cached (ms)",
    "transcript_first_page_ms": "GET transcript first page (ms)",
    "transcript_next_page_ms": "GET transcript next page (ms)",
    "transcript_search_ms": "GET transcript search (ms)",
    "transcript_entry_ms": "GET transcript entry (ms)",
}


def _timestamp(seconds: float) -> str:
    return (_T0 + timedelta(seconds=seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _entry(uuid: str, seconds: float, entry_type: str, message: dict[str, Any]) -> dict[str, Any]:
    return {
        "uuid": uuid,
        "timestamp": _timestamp(seconds),
        "sessionId": _SESSION_ID,
        "cwd": "/home/user/bench",
        "isSidechain": False,
        "version": "2.1.200",
        "type": entry_type,
        "message": message,
    }


def _usage(turn: int) -> dict[str, int]:
    return {
        "input_tokens": 50,
        "output_tokens": 200,
        "cache_read_input_tokens": 20_000 + turn * 10,
        "cache_creation_input_tokens": 3_000,
    }


def _turn_lines(turn: int) -> list[dict[str, Any]]:
    """One prompt, a Read tool call with a ~8 KB result, and a closing answer."""
    start = turn * 30
    tool_id = f"toolu_{turn}"
    result = "\n".join(f"{line:5}\tvalue_{turn}_{line} = compute({line})" for line in range(_RESULT_LINES))
    if turn % _NEEDLE_EVERY == 0:
        result += "\n# needle"
    return [
        _entry(f"u{turn}", start, "user", {"role": "user", "content": f"Task {turn}: inspect module {turn}"}),
        _entry(
            f"a{turn}",
            start + 1,
            "assistant",
            {
                "id": f"msg_{turn}_a",
                "type": "message",
                "role": "assistant",
                "model": "claude-sonnet-5",
                "content": [
                    {"type": "tool_use", "id": tool_id, "name": "Read", "input": {"file_path": f"/repo/m{turn}.py"}}
                ],
                "usage": _usage(turn),
            },
        ),
        _entry(
            f"r{turn}",
            start + 2,
            "user",
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": result}]},
        ),
        _entry(
            f"b{turn}",
            start + 3,
            "assistant",
            {
                "id": f"msg_{turn}_b",
                "type": "message",
                "role": "assistant",
                "model": "claude-sonnet-5",
                "content": [{"type": "text", "text": f"Checked module {turn}."}],
                "usage": _usage(turn),
            },
        ),
    ]


def write_session(directory: Path, target_bytes: int) -> Path:
    """Write one Claude Code session of at least `target_bytes` under `directory`; returns the projects root."""
    projects = directory / "projects"
    project = projects / _PROJECT
    project.mkdir(parents=True)
    written = 0
    turn = 0
    with (project / f"{_SESSION_ID}.jsonl").open("w", encoding="utf-8") as session_file:
        title = json.dumps({"type": "ai-title", "aiTitle": "Benchmark session", "sessionId": _SESSION_ID})
        written += session_file.write(title + "\n")
        while written < target_bytes:
            for entry in _turn_lines(turn):
                written += session_file.write(json.dumps(entry) + "\n")
            turn += 1
    return projects


def _timed(action: Callable[[], object]) -> float:
    start = time.perf_counter()
    action()
    return time.perf_counter() - start


def _peak_mb(action: Callable[[], object]) -> float:
    tracemalloc.start()
    try:
        action()
        return tracemalloc.get_traced_memory()[1] / 1024**2
    finally:
        tracemalloc.stop()


def _median_ms(client: TestClient, url: str, repeats: int) -> float:
    def get() -> None:
        client.get(url).raise_for_status()

    return statistics.median(_timed(get) for _ in range(repeats)) * 1000


def measure(projects: Path, repeats: int = 5) -> dict[str, float]:
    """Measure the session under `projects`; request latencies are medians of `repeats` requests."""
    adapter = ClaudeCodeAdapter(AdapterConfig(roots={"claude-code": projects}))
    ref = next(iter(adapter.discover()))
    metrics = {
        "summarize_s": _timed(lambda: adapter.summarize(ref)),
        "summarize_peak_mb": _peak_mb(lambda: adapter.summarize(ref)),
        "analyze_s": _timed(lambda: analyze(adapter, ref)),
        "analyze_peak_mb": _peak_mb(lambda: analyze(adapter, ref)),
    }
    registry = Registry([adapter])
    registry.refresh()
    client = TestClient(create_app(registry))
    base = f"/api/sessions/{ref.id}"
    session = client.get(base).json()
    node_id = session["root"]["children"][-1]["node_id"]
    first_page = client.get(f"{base}/transcript?limit=50").json()
    entry_id = first_page["entries"][-1]["entry_id"]
    # A session smaller than one page has no next cursor; the first page stands in for it.
    next_page_url = f"{base}/transcript?limit=50"
    if first_page["next_cursor"] is not None:
        next_page_url += f"&after={first_page['next_cursor']}"
    metrics |= {
        "session_ms": _median_ms(client, base, repeats),
        "node_ms": _median_ms(client, f"{base}/nodes/{node_id}", repeats),
        "transcript_first_page_ms": _median_ms(client, f"{base}/transcript?limit=50", repeats),
        "transcript_next_page_ms": _median_ms(client, next_page_url, repeats),
        "transcript_search_ms": _median_ms(client, f"{base}/transcript/search?q=needle", repeats),
        "transcript_entry_ms": _median_ms(client, f"{base}/transcript/entries/{entry_id}", repeats),
    }
    return {key: metrics[key] for key in METRICS}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--size-mb", type=float, default=50.0, help="size of the generated session (default 50)")
    parser.add_argument("--repeats", type=int, default=5, help="requests per latency median (default 5)")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="agentprof-bench-") as directory:
        projects = write_session(Path(directory), int(args.size_mb * 1024**2))
        metrics = measure(projects, args.repeats)
    print(f"| metric ({args.size_mb:g} MB session) | value |")
    print("|---|---|")
    for key, label in METRICS.items():
        print(f"| {label} | {metrics[key]:.2f} |")
