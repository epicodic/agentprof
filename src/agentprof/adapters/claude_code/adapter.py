# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""The Claude Code adapter."""

import json
import os
from collections import Counter
from collections.abc import Iterator
from pathlib import Path

from agentprof.adapters.base import AdapterConfig, SessionRef, SessionSummary, latest_mtime
from agentprof.adapters.claude_code.discovery import (
    default_projects_root,
    load_subagents,
    session_files,
    subagent_dir,
)
from agentprof.adapters.claude_code.prompts import NO_PROMPT, prompt_topic
from agentprof.adapters.claude_code.tools import is_known_tool_id
from agentprof.adapters.claude_code.transcript import Transcript, load_transcript
from agentprof.adapters.claude_code.tree import build_root, message_cost
from agentprof.model import Diagnostics, Session, sum_costs
from agentprof.pricing import PriceTable

_TITLE_LENGTH = 80
_SNIFF_LINES = 20
_SUBAGENT_DIR = "subagents"


def _title(main: Transcript, fallback: str) -> str:
    if main.title:
        return main.title
    for prompt in main.prompts:
        topic = prompt_topic(prompt.text)
        if topic != NO_PROMPT:
            return topic[:_TITLE_LENGTH]
    return fallback


def _looks_like_session(path: Path) -> bool:
    """Whether one of the first lines is a Claude Code entry carrying a `sessionId`."""
    try:
        with path.open(encoding="utf-8") as lines:
            for _, line in zip(range(_SNIFF_LINES), lines, strict=False):
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict) and isinstance(entry.get("sessionId"), str):
                    return True
    except (OSError, UnicodeDecodeError):
        return False
    return False


class ClaudeCodeAdapter:
    """Reads Claude Code sessions from `~/.claude/projects`."""

    name = "claude-code"

    def __init__(self, config: AdapterConfig) -> None:
        override = config.roots.get(self.name)
        self._root = override if override is not None else default_projects_root(os.environ, Path.home())
        self._prices = PriceTable.load(config.pricing_file)

    def _ref(self, path: Path) -> SessionRef:
        files = [path, *subagent_dir(path).glob("agent-*")]
        return SessionRef(agent=self.name, native_id=path.stem, path=path, mtime=latest_mtime(files))

    def discover(self) -> Iterator[SessionRef]:
        for path in session_files(self._root):
            yield self._ref(path)

    def open_path(self, path: Path) -> SessionRef | None:
        if path.suffix != ".jsonl" or path.parent.name == _SUBAGENT_DIR or not path.is_file():
            return None
        return self._ref(path) if _looks_like_session(path) else None

    def summarize(self, ref: SessionRef) -> SessionSummary:
        main = load_transcript(ref.path)
        transcripts = [main, *(subagent.transcript for subagent in load_subagents(ref.path))]
        return SessionSummary(
            id=ref.id,
            agent=self.name,
            title=_title(main, ref.native_id),
            workspace=main.cwd,
            start_ms=main.first_timestamp_ms if main.first_timestamp_ms is not None else ref.mtime * 1000,
            end_ms=ref.mtime * 1000,
            file_size=ref.path.stat().st_size,
            last_activity_ms=max(
                (timestamp for transcript in transcripts if (timestamp := transcript.last_message_ms) is not None),
                default=None,
            ),
            cost_total=sum_costs(
                [message_cost(message, self._prices) for transcript in transcripts for message in transcript.messages]
            ),
        )

    def analyze(self, ref: SessionRef) -> Session:
        main = load_transcript(ref.path)
        subagents = load_subagents(ref.path)
        transcripts = [main, *(subagent.transcript for subagent in subagents)]
        diagnostics = Diagnostics(malformed_lines=sum(transcript.malformed_lines for transcript in transcripts))
        diagnostics.malformed_line_details = [
            detail for transcript in transcripts for detail in transcript.malformed_line_details
        ][:20]
        diagnostics.unknown_tool_ids = dict(
            Counter(
                tool_use.name
                for transcript in transcripts
                for tool_use in transcript.tool_uses
                if not is_known_tool_id(tool_use.name)
            )
        )
        unpriced = sorted(
            {
                message.model
                for transcript in transcripts
                for message in transcript.messages
                if message.model and self._prices.price_for(message.model) is None
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
            sources=["transcript", *(["subagents"] if subagents else [])],
            diagnostics=diagnostics,
        )
