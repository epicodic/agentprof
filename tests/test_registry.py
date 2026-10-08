# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import os
import shutil
import threading
import time
from collections.abc import Callable, Iterable
from pathlib import Path

import pytest

from agentprof.adapters.base import AdapterConfig, SessionRef, SessionSummary
from agentprof.adapters.claude_code.adapter import ClaudeCodeAdapter
from agentprof.model import CostMetric, LlmCall, Metric, Node, NodeKind, Provenance, Session, Tokens
from agentprof.registry import EventKind, Registry, RegistryEvent, RowState, SessionUnavailable


class FakeAdapter:
    """An in-memory adapter whose sessions and failures the tests control."""

    def __init__(self, name: str = "fake") -> None:
        self.name = name
        self.refs: dict[str, SessionRef] = {}
        self.broken: set[str] = set()
        self.summarized: list[str] = []
        self.analyzed: list[str] = []

    def add(self, native_id: str, mtime: float) -> None:
        self.refs[native_id] = SessionRef(
            agent=self.name, native_id=native_id, path=Path(f"/{native_id}.jsonl"), mtime=mtime
        )

    def discover(self) -> Iterable[SessionRef]:
        return iter(list(self.refs.values()))

    def open_path(self, path: Path) -> SessionRef | None:
        return None

    def summarize(self, ref: SessionRef) -> SessionSummary:
        self.summarized.append(ref.native_id)
        if ref.native_id in self.broken:
            raise ValueError("broken file")
        return SessionSummary(
            id=ref.id,
            agent=self.name,
            title=f"title {ref.native_id}",
            workspace=None,
            start_ms=0,
            end_ms=0,
            file_size=1,
            cost_total=CostMetric(value=0.5, unit="USD", provenance=Provenance.ESTIMATED),
        )

    def analyze(self, ref: SessionRef) -> Session:
        self.analyzed.append(ref.native_id)
        if ref.native_id in self.broken:
            raise ValueError("broken file")
        call = LlmCall(
            start=Metric.exact(0),
            tokens=Tokens(input=Metric.exact(10), output=Metric.exact(5)),
            cost=CostMetric(value=0.5, unit="USD", provenance=Provenance.ESTIMATED),
        )
        turn = Node(node_id="t1", kind=NodeKind.TURN, topic="t", prompt="hello", llm_calls=[call])
        root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[turn])
        return Session(id=ref.id, agent=self.name, title="t", workspace=None, root=root)


def _registry(adapter: FakeAdapter) -> tuple[Registry, list[RegistryEvent]]:
    registry = Registry([adapter])
    events: list[RegistryEvent] = []
    registry.subscribe(events.append)
    return registry, events


def _drain(registry: Registry) -> None:
    while registry.step():
        pass


def test_refresh_adds_a_pending_row_per_discovered_session() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    adapter.add("b", 200.0)
    registry, events = _registry(adapter)

    registry.refresh()

    assert [(row.ref.id, row.state) for row in registry.rows()] == [
        ("fake:b", RowState.PENDING),
        ("fake:a", RowState.PENDING),
    ]
    assert sorted(event.session_id for event in events) == ["fake:a", "fake:b"]
    assert {event.kind for event in events} == {EventKind.UPDATED}


def test_step_summarizes_everything_newest_first_and_never_analyses() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    adapter.add("b", 200.0)
    registry, _ = _registry(adapter)
    registry.refresh()

    _drain(registry)

    assert adapter.summarized == ["b", "a"]
    assert adapter.analyzed == []
    assert registry.step() is False


def test_summarized_rows_carry_the_summary() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    registry, events = _registry(adapter)
    registry.refresh()

    _drain(registry)

    row = registry.row("fake:a")
    assert row is not None
    assert row.state is RowState.SUMMARIZED
    assert row.summary is not None and row.summary.title == "title a"
    assert row.summary.cost_total == CostMetric(value=0.5, unit="USD", provenance=Provenance.ESTIMATED)
    assert len(events) == 2  # added, summarised


def test_a_failing_session_becomes_an_error_row_until_it_changes() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    adapter.broken.add("a")
    registry, _ = _registry(adapter)
    registry.refresh()

    _drain(registry)

    row = registry.row("fake:a")
    assert row is not None
    assert row.state is RowState.ERROR
    assert row.error == "ValueError: broken file"
    assert adapter.summarized == ["a"]

    adapter.broken.clear()
    adapter.add("a", 150.0)
    registry.refresh()
    _drain(registry)

    row = registry.row("fake:a")
    assert row is not None and row.state is RowState.SUMMARIZED


def test_a_changed_session_is_queued_again_and_keeps_its_old_summary_meanwhile() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    registry, events = _registry(adapter)
    registry.refresh()
    _drain(registry)
    events.clear()

    adapter.add("a", 300.0)
    registry.refresh()

    row = registry.row("fake:a")
    assert row is not None
    assert row.state is RowState.PENDING
    assert row.summary is not None
    assert events == [RegistryEvent(kind=EventKind.UPDATED, session_id="fake:a")]
    _drain(registry)
    assert adapter.summarized == ["a", "a"]


def test_a_vanished_session_is_removed() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    registry, events = _registry(adapter)
    registry.refresh()
    events.clear()

    del adapter.refs["a"]
    registry.refresh()

    assert registry.rows() == []
    assert events == [RegistryEvent(kind=EventKind.REMOVED, session_id="fake:a")]


def test_a_failing_discover_keeps_the_adapters_rows() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    registry, _ = _registry(adapter)
    registry.refresh()

    def broken_discover() -> Iterable[SessionRef]:
        raise OSError("disk gone")

    setattr(adapter, "discover", broken_discover)  # noqa: B010 - ty rejects a direct assignment here
    registry.refresh()

    assert [row.ref.id for row in registry.rows()] == ["fake:a"]


def test_unsubscribe_stops_events() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    registry = Registry([adapter])
    events: list[RegistryEvent] = []
    unsubscribe = registry.subscribe(events.append)

    unsubscribe()
    registry.refresh()

    assert events == []


def test_session_analyses_on_demand_and_caches_per_file_version() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    registry, _ = _registry(adapter)
    registry.refresh()

    session, mtime = registry.session("fake:a")
    registry.session("fake:a")

    assert session.id == "fake:a"
    assert mtime == 100.0
    assert adapter.analyzed == ["a"]
    row = registry.row("fake:a")
    assert row is not None and row.state is RowState.PENDING  # an analysis does not summarise

    adapter.add("a", 200.0)
    registry.refresh()
    _, mtime = registry.session("fake:a")
    assert mtime == 200.0
    assert adapter.analyzed == ["a", "a"]


def test_session_cache_evicts_the_least_recently_used() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    adapter.add("b", 200.0)
    registry = Registry([adapter], cache_size=1)
    registry.refresh()

    registry.session("fake:a")
    registry.session("fake:b")
    registry.session("fake:a")

    assert adapter.analyzed == ["a", "b", "a"]


def test_session_of_an_unknown_id_raises_key_error() -> None:
    registry, _ = _registry(FakeAdapter())

    with pytest.raises(KeyError):
        registry.session("fake:missing")


def test_session_that_cannot_be_analysed_raises_session_unavailable() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    adapter.broken.add("a")
    registry, _ = _registry(adapter)
    registry.refresh()

    with pytest.raises(SessionUnavailable, match="broken file"):
        registry.session("fake:a")


def test_resolve_accepts_prefixed_and_unambiguous_bare_ids() -> None:
    first, second = FakeAdapter("one"), FakeAdapter("two")
    first.add("a", 100.0)
    first.add("shared", 100.0)
    second.add("shared", 100.0)
    registry = Registry([first, second])
    registry.refresh()

    assert registry.resolve("one:a") == "one:a"
    assert registry.resolve("a") == "one:a"
    with pytest.raises(LookupError, match="ambiguous"):
        registry.resolve("shared")
    with pytest.raises(LookupError, match="unknown session"):
        registry.resolve("nothing")


def test_resolve_opens_a_path_and_pins_its_row(tmp_path: Path) -> None:
    session_file = tmp_path / "export.json"
    session_file.write_text("{}")
    adapter = FakeAdapter()
    pinned_ref = SessionRef(agent="fake", native_id="exported", path=session_file, mtime=5.0)
    setattr(adapter, "open_path", lambda path: pinned_ref if path == session_file else None)  # noqa: B010
    registry, _ = _registry(adapter)

    assert registry.resolve(str(session_file)) == "fake:exported"
    registry.refresh()

    row = registry.row("fake:exported")
    assert row is not None and row.pinned


def test_resolve_rejects_a_path_no_adapter_recognises(tmp_path: Path) -> None:
    other = tmp_path / "notes.txt"
    other.write_text("x")
    registry, _ = _registry(FakeAdapter())

    with pytest.raises(LookupError, match="no adapter recognises"):
        registry.resolve(str(other))


_CLAUDE_PROJECTS = Path(__file__).parent / "adapters" / "claude_code" / "fixtures" / "projects"


def _wait_until(condition: Callable[[], bool], timeout_s: float = 5.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError("condition not reached in time")


def test_background_thread_summarizes_every_session() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    adapter.add("b", 200.0)
    registry = Registry([adapter])

    registry.start(interval_s=0.05)
    try:
        _wait_until(
            lambda: all(row.state is RowState.SUMMARIZED for row in registry.rows()) and len(registry.rows()) == 2
        )
    finally:
        registry.stop()


def test_background_thread_picks_up_new_sessions() -> None:
    adapter = FakeAdapter()
    registry = Registry([adapter])

    registry.start(interval_s=0.05)
    try:
        adapter.add("late", 100.0)
        _wait_until(lambda: registry.row("fake:late") is not None)
    finally:
        registry.stop()


def test_claude_session_is_requeued_when_a_subagent_file_changes(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    shutil.copytree(_CLAUDE_PROJECTS, projects)
    registry = Registry([ClaudeCodeAdapter(AdapterConfig(roots={"claude-code": projects}))])
    registry.refresh()
    _drain(registry)
    (row,) = registry.rows()
    assert row.state is RowState.SUMMARIZED
    assert row.summary is not None and row.summary.cost_total.unit == "USD"

    subagent = next((projects / "-home-user-demo").glob("*/subagents/agent-bbb.jsonl"))
    newer = row.ref.mtime + 100
    os.utime(subagent, (newer, newer))
    registry.refresh()

    (row,) = registry.rows()
    assert row.state is RowState.PENDING


def test_a_failing_subscriber_neither_stops_other_subscribers_nor_the_worker() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    registry = Registry([adapter])
    received: list[RegistryEvent] = []

    def failing(event: RegistryEvent) -> None:
        raise RuntimeError("client went away")

    registry.subscribe(failing)
    registry.subscribe(received.append)
    registry.start(interval_s=0.05)
    try:
        adapter.add("b", 200.0)
        _wait_until(lambda: len(registry.rows()) == 2 and all(r.state is RowState.SUMMARIZED for r in registry.rows()))
    finally:
        registry.stop()

    assert received


def test_concurrent_requests_share_one_analysis() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    registry = Registry([adapter])
    registry.refresh()
    gate = threading.Event()
    original = adapter.analyze

    def slow_analyze(ref: SessionRef) -> Session:
        gate.wait(timeout=5)
        return original(ref)

    setattr(adapter, "analyze", slow_analyze)  # noqa: B010
    results: list[float] = []
    threads = [threading.Thread(target=lambda: results.append(registry.session("fake:a")[1])) for _ in range(3)]
    for thread in threads:
        thread.start()
    time.sleep(0.1)
    gate.set()
    for thread in threads:
        thread.join(timeout=5)

    assert results == [100.0, 100.0, 100.0]
    assert adapter.analyzed == ["a"]


def test_worker_survives_a_failing_iteration() -> None:
    adapter = FakeAdapter()
    adapter.add("a", 100.0)
    registry = Registry([adapter])
    original = registry.step
    failures = [RuntimeError("boom")]

    def flaky_step() -> bool:
        if failures:
            raise failures.pop()
        return original()

    setattr(registry, "step", flaky_step)  # noqa: B010
    registry.start(interval_s=0.05)
    try:
        _wait_until(lambda: _state(registry, "fake:a") is RowState.SUMMARIZED)
    finally:
        registry.stop()


def _state(registry: Registry, session_id: str) -> RowState | None:
    row = registry.row(session_id)
    return row.state if row is not None else None
