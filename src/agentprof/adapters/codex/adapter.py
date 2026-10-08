# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""The Codex CLI rollout adapter."""

from collections import Counter
from collections.abc import Iterator
from pathlib import Path

from agentprof.adapters.base import AdapterConfig, SessionRef, SessionSummary, latest_mtime
from agentprof.adapters.codex.discovery import SessionFiles, default_sessions_root, read_metadata, session_files
from agentprof.adapters.codex.prompts import first_line
from agentprof.adapters.codex.rollout import Rollout, UsageRecord, load_rollout
from agentprof.adapters.codex.tools import is_known_tool_id
from agentprof.adapters.codex.tree import build_root
from agentprof.model import CostMetric, Diagnostics, Session, sum_costs
from agentprof.pricing import PriceTable, Usage

_TITLE_LENGTH = 80


def _merge_main_rollouts(rollouts: list[Rollout]) -> Rollout:
    """Merge root continuation rollouts into one chronological main conversation."""
    if not rollouts:
        return Rollout()
    main = rollouts[0]
    for continuation in rollouts[1:]:
        main.turns.extend(continuation.turns)
        main.malformed_lines += continuation.malformed_lines
        if continuation.last_message_ms is not None:
            main.last_message_ms = max(
                main.last_message_ms or continuation.last_message_ms, continuation.last_message_ms
            )
    main.turns.sort(key=lambda turn: turn.start_ms if turn.start_ms is not None else float("inf"))
    return main


def _title(main: Rollout, fallback: str) -> str:
    """Return the first root-user prompt topic, or the stable native id."""
    for turn in main.turns:
        if turn.prompt:
            return first_line(turn.prompt, _TITLE_LENGTH) or fallback
    return fallback


def _usage(usage: UsageRecord) -> Usage:
    """Convert Codex token categories to the shared pricing representation."""
    return Usage(
        input=usage.input,
        output=usage.output,
        cache_read=usage.cache_read,
        cache_write_5m=usage.cache_write,
        cache_write_1h=0,
    )


def _costs(rollouts: list[Rollout], prices: PriceTable) -> list[CostMetric]:
    """Return one estimated cost for every native usage record."""
    return [
        prices.cost(turn.model, _usage(record.usage))
        for rollout in rollouts
        for turn in rollout.turns
        for record in turn.token_usages
    ]


class CodexAdapter:
    """Reads local Codex CLI rollout sessions from ``~/.codex/sessions``."""

    name = "codex"

    def __init__(self, config: AdapterConfig) -> None:
        override = config.roots.get(self.name)
        self._root = override if override is not None else default_sessions_root(Path.home())
        self._prices = PriceTable.load(config.pricing_file)

    def _ref(self, files: SessionFiles) -> SessionRef:
        path = files.main if files.main is not None else files.files[0]
        return SessionRef(
            agent=self.name,
            native_id=files.session_id,
            path=path,
            mtime=latest_mtime(files.files),
        )

    def _files_for_id(self, session_id: str) -> SessionFiles | None:
        return next((files for files in session_files(self._root) if files.session_id == session_id), None)

    def _load(self, ref: SessionRef) -> tuple[SessionFiles, Rollout, list[Rollout]]:
        files = self._files_for_id(ref.native_id)
        if files is None:
            metadata = read_metadata(ref.path)
            if metadata is None:
                raise ValueError(f"cannot read Codex rollout {ref.path}")
            files = SessionFiles(metadata.session_id, ref.path, [ref.path], [metadata])
        roots = [rollout.path for rollout in files.rollouts if rollout.parent_thread_id is None]
        main_paths = roots or [ref.path]
        main = _merge_main_rollouts([load_rollout(path) for path in main_paths])
        subagents = [load_rollout(rollout.path) for rollout in files.rollouts if rollout.path not in main_paths]
        return files, main, subagents

    def discover(self) -> Iterator[SessionRef]:
        for files in session_files(self._root):
            yield self._ref(files)

    def open_path(self, path: Path) -> SessionRef | None:
        metadata = read_metadata(path) if path.suffix == ".jsonl" and path.is_file() else None
        if metadata is None:
            return None
        files = self._files_for_id(metadata.session_id)
        if files is not None:
            return self._ref(files)
        return SessionRef(agent=self.name, native_id=metadata.session_id, path=path, mtime=latest_mtime([path]))

    def summarize(self, ref: SessionRef) -> SessionSummary:
        files, main, subagents = self._load(ref)
        rollouts = [main, *subagents]
        start_ms = next((turn.start_ms for turn in main.turns if turn.start_ms is not None), None)
        return SessionSummary(
            id=ref.id,
            agent=self.name,
            title=_title(main, ref.native_id),
            workspace=main.cwd,
            start_ms=start_ms if start_ms is not None else ref.mtime * 1000,
            end_ms=ref.mtime * 1000,
            file_size=sum(path.stat().st_size for path in files.files),
            last_activity_ms=max(
                (timestamp for rollout in rollouts if (timestamp := rollout.last_message_ms) is not None),
                default=None,
            ),
            cost_total=sum_costs(_costs(rollouts, self._prices)),
        )

    def analyze(self, ref: SessionRef) -> Session:
        _, main, subagents = self._load(ref)
        rollouts = [main, *subagents]
        diagnostics = Diagnostics(malformed_lines=sum(rollout.malformed_lines for rollout in rollouts))
        diagnostics.unknown_tool_ids = dict(
            Counter(
                tool.name
                for rollout in rollouts
                for turn in rollout.turns
                for tool in turn.tools
                if not is_known_tool_id(tool.name)
            )
        )
        unpriced = sorted(
            {
                turn.model
                for rollout in rollouts
                for turn in rollout.turns
                if turn.model and turn.token_usages and self._prices.price_for(turn.model) is None
            }
        )
        diagnostics.warnings.extend(f"No price for model {model!r}: its cost is unavailable." for model in unpriced)
        title = _title(main, ref.native_id)
        return Session(
            id=ref.id,
            agent=self.name,
            title=title,
            workspace=main.cwd,
            root=build_root(main, subagents, self._prices, title),
            sources=["rollout", *(["subagents"] if subagents else [])],
            diagnostics=diagnostics,
        )
