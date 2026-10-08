# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""The adapter protocol and the lightweight types the registry works with."""

from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from agentprof.model import CostMetric, Session


def latest_mtime(paths: Iterable[Path]) -> float:
    """The newest modification time among `paths`; paths that vanished meanwhile are ignored."""
    times: list[float] = []
    for path in paths:
        try:
            times.append(path.stat().st_mtime)
        except OSError:
            continue
    return max(times, default=0.0)


@dataclass(frozen=True)
class AdapterConfig:
    """User configuration shared by all adapters.

    `roots` maps an adapter name to an overriding data root; `pricing_file` replaces the bundled price table.
    """

    roots: dict[str, Path] = field(default_factory=dict)
    pricing_file: Path | None = None


@dataclass(frozen=True)
class SessionRef:
    """A cheap handle to one session file."""

    agent: str
    native_id: str
    path: Path
    mtime: float

    @property
    def id(self) -> str:
        return f"{self.agent}:{self.native_id}"


@dataclass
class SessionSummary:
    """One row of the session list: only what an adapter can read without building the tree."""

    id: str
    agent: str
    title: str
    workspace: str | None
    start_ms: float | None
    end_ms: float | None
    file_size: int
    last_activity_ms: float | None = None
    cost_total: CostMetric = field(default_factory=CostMetric.not_available)


class AgentAdapter(Protocol):
    """Turns one agent's session files into the neutral model.

    Implementations are constructed with an `AdapterConfig` and registered under the entry point group
    `agentprof.adapters`. `summarize` and `analyze` raise on sessions they cannot read.
    """

    name: str

    def discover(self) -> Iterable[SessionRef]: ...

    def open_path(self, path: Path) -> SessionRef | None: ...

    def summarize(self, ref: SessionRef) -> SessionSummary: ...

    def analyze(self, ref: SessionRef) -> Session: ...
