# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Keep one up-to-date row per session: discover and summarise in the background, analyse on demand, follow changes."""

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path

from agentprof.adapters.base import AgentAdapter, SessionRef, SessionSummary
from agentprof.analysis.pipeline import analyze
from agentprof.model import Session

_LOG = logging.getLogger(__name__)
_DEFAULT_CACHE_SIZE = 20
_DEFAULT_INTERVAL_S = 3.0


class RowState(StrEnum):
    """Progress of a row, relative to the session's current modification time."""

    PENDING = "pending"
    SUMMARIZED = "summarized"
    ERROR = "error"


class EventKind(StrEnum):
    UPDATED = "updated"
    REMOVED = "removed"


@dataclass(frozen=True)
class RegistryEvent:
    kind: EventKind
    session_id: str


@dataclass
class SessionRow:
    """One session in the list. `*_mtime` record which file version each result belongs to."""

    ref: SessionRef
    summary: SessionSummary | None = None
    error: str | None = None
    summarized_mtime: float | None = None
    failed_mtime: float | None = None
    pinned: bool = False

    @property
    def state(self) -> RowState:
        mtime = self.ref.mtime
        if self.failed_mtime == mtime:
            return RowState.ERROR
        if self.summarized_mtime != mtime:
            return RowState.PENDING
        return RowState.SUMMARIZED


class SessionUnavailable(Exception):
    """A known session whose files could not be analysed."""


def _mtime(ref: SessionRef) -> float:
    return ref.mtime


def _describe(error: Exception) -> str:
    return f"{type(error).__name__}: {error}"


class Registry:
    """Thread-safe store of session rows; `step` summarises one row in the background."""

    def __init__(self, adapters: list[AgentAdapter], cache_size: int = _DEFAULT_CACHE_SIZE) -> None:
        self._adapters = {adapter.name: adapter for adapter in adapters}
        self._cache_size = cache_size
        self._rows: dict[str, SessionRow] = {}
        self._cache: OrderedDict[str, tuple[float, Session]] = OrderedDict()
        self._in_flight: dict[tuple[str, float], threading.Event] = {}
        self._subscribers: list[Callable[[RegistryEvent], None]] = []
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def subscribe(self, callback: Callable[[RegistryEvent], None]) -> Callable[[], None]:
        """Call `callback` for every event, from whichever thread caused it; returns an unsubscribe function."""
        with self._lock:
            self._subscribers.append(callback)

        def unsubscribe() -> None:
            with self._lock:
                if callback in self._subscribers:
                    self._subscribers.remove(callback)

        return unsubscribe

    def _emit(self, events: list[RegistryEvent]) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for event in events:
            for callback in subscribers:
                try:
                    callback(event)
                except Exception:  # noqa: BLE001 - one failing subscriber must not stop the others or the worker
                    _LOG.exception("registry subscriber failed on %s", event)

    def rows(self) -> list[SessionRow]:
        """A snapshot of all rows, most recently changed first."""
        with self._lock:
            rows = [replace(row) for row in self._rows.values()]
        return sorted(rows, key=lambda row: row.ref.mtime, reverse=True)

    def row(self, session_id: str) -> SessionRow | None:
        with self._lock:
            row = self._rows.get(session_id)
            return replace(row) if row is not None else None

    def _discover(self) -> tuple[dict[str, SessionRef], set[str]]:
        discovered: dict[str, SessionRef] = {}
        failed: set[str] = set()
        for adapter in self._adapters.values():
            try:
                refs = list(adapter.discover())
            except Exception:  # noqa: BLE001 - one broken adapter must not stop the others
                failed.add(adapter.name)
                continue
            discovered.update((ref.id, ref) for ref in refs)
        return discovered, failed

    def _reopen_pinned(self, discovered: dict[str, SessionRef]) -> None:
        with self._lock:
            pinned = [row.ref for row in self._rows.values() if row.pinned and row.ref.id not in discovered]
        for ref in pinned:
            reopened = self._adapters[ref.agent].open_path(ref.path)
            if reopened is not None:
                discovered[reopened.id] = reopened

    def refresh(self) -> None:
        """Discover sessions of every adapter: add new rows, re-queue changed ones, drop vanished ones."""
        discovered, failed = self._discover()
        self._reopen_pinned(discovered)
        events: list[RegistryEvent] = []
        with self._lock:
            for session_id, ref in discovered.items():
                row = self._rows.get(session_id)
                if row is None:
                    self._rows[session_id] = SessionRow(ref=ref)
                elif row.ref.mtime != ref.mtime:
                    row.ref = ref
                else:
                    continue
                events.append(RegistryEvent(kind=EventKind.UPDATED, session_id=session_id))
            vanished = [
                session_id
                for session_id, row in self._rows.items()
                if session_id not in discovered and row.ref.agent not in failed
            ]
            for session_id in vanished:
                self._forget(session_id)
                events.append(RegistryEvent(kind=EventKind.REMOVED, session_id=session_id))
        self._emit(events)

    def _forget(self, session_id: str) -> None:
        """Drop a row and its cached analysis; the lock must be held."""
        del self._rows[session_id]
        self._cache.pop(session_id, None)

    def _next_pending(self) -> SessionRef | None:
        """The most recently changed row without a current summary."""
        with self._lock:
            pending = [row.ref for row in self._rows.values() if row.state is RowState.PENDING]
        return max(pending, key=_mtime) if pending else None

    def step(self) -> bool:
        """Summarise one row; returns `False` when every row is current."""
        ref = self._next_pending()
        if ref is None:
            return False
        try:
            summary = self._adapters[ref.agent].summarize(ref)
            self._update(ref, lambda row: _set_summary(row, summary))
        except Exception as error:  # noqa: BLE001 - any unreadable session becomes an error row
            message = _describe(error)
            self._update(ref, lambda row: _set_error(row, message))
        return True

    def _update(self, ref: SessionRef, change: Callable[[SessionRow], None]) -> None:
        """Apply `change` if the row still describes the same file version, then emit an event."""
        with self._lock:
            row = self._rows.get(ref.id)
            if row is None or row.ref.mtime != ref.mtime:
                return
            change(row)
        self._emit([RegistryEvent(kind=EventKind.UPDATED, session_id=ref.id)])

    def session(self, session_id: str) -> tuple[Session, float]:
        """The analysed session and the file version it describes; analyses now unless cached.

        Raises:
            KeyError: `session_id` is not a known session.
            SessionUnavailable: the session's files could not be analysed.
        """
        with self._lock:
            row = self._rows.get(session_id)
            if row is None:
                raise KeyError(session_id)
            ref = row.ref
            cached = self._cache.get(session_id)
            if cached is not None and cached[0] == ref.mtime:
                self._cache.move_to_end(session_id)
                return cached[1], ref.mtime
            key = (session_id, ref.mtime)
            running = self._in_flight.get(key)
            if running is None:
                self._in_flight[key] = threading.Event()
        if running is not None:  # another request analyses this file version already: share its result
            running.wait()
            return self.session(session_id)
        try:
            session = analyze(self._adapters[ref.agent], ref)
        except Exception as error:  # noqa: BLE001 - reported to the caller as unavailable
            raise SessionUnavailable(_describe(error)) from error
        else:
            with self._lock:
                self._cache[session_id] = (ref.mtime, session)
                self._cache.move_to_end(session_id)
                while len(self._cache) > self._cache_size:
                    self._cache.popitem(last=False)
        finally:
            with self._lock:
                self._in_flight.pop(key).set()
        return session, ref.mtime

    def resolve(self, text: str) -> str:
        """Turn a CLI argument into a session id: `<agent>:<id>`, an unambiguous bare id, or a session file path.

        A path outside the adapter roots is added as a pinned row.

        Raises:
            LookupError: the argument names no session or several.
        """
        with self._lock:
            if text in self._rows:
                return text
            matches = sorted(session_id for session_id, row in self._rows.items() if row.ref.native_id == text)
        if len(matches) == 1:
            return matches[0]
        if matches:
            raise LookupError(f"ambiguous session id {text!r}: {', '.join(matches)}")
        path = Path(text).expanduser()
        if not path.exists():
            raise LookupError(f"unknown session {text!r}")
        for adapter in self._adapters.values():
            ref = adapter.open_path(path.resolve())
            if ref is None:
                continue
            with self._lock:
                if ref.id not in self._rows:
                    self._rows[ref.id] = SessionRow(ref=ref, pinned=True)
            self._emit([RegistryEvent(kind=EventKind.UPDATED, session_id=ref.id)])
            return ref.id
        raise LookupError(f"no adapter recognises {path}")

    def start(self, interval_s: float = _DEFAULT_INTERVAL_S) -> None:
        """Run `refresh` every `interval_s` seconds and `step` whenever there is work, in a daemon thread."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, args=(interval_s,), name="agentprof-registry", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop the background thread and wait for its current unit of work."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None

    def _run(self, interval_s: float) -> None:
        next_refresh = time.monotonic()
        while not self._stop.is_set():
            try:
                if time.monotonic() >= next_refresh:
                    next_refresh = time.monotonic() + interval_s
                    self.refresh()
                if not self.step():
                    self._stop.wait(max(0.0, next_refresh - time.monotonic()))
            except Exception:  # noqa: BLE001 - the worker must outlive any single failure
                _LOG.exception("registry worker iteration failed")
                self._stop.wait(interval_s)


def _set_summary(row: SessionRow, summary: SessionSummary) -> None:
    row.summary = summary
    row.summarized_mtime = row.ref.mtime


def _set_error(row: SessionRow, message: str) -> None:
    row.error = message
    row.failed_mtime = row.ref.mtime
