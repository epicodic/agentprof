# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""The VS Code Copilot Chat adapter."""

import json
import os
import sys
from collections import Counter
from collections.abc import Iterator
from pathlib import Path

from agentprof.adapters.base import AdapterConfig, SessionRef, SessionSummary, latest_mtime
from agentprof.adapters.copilot_vscode.debuglog import DebugLog, load_debug_log_dir
from agentprof.adapters.copilot_vscode.discovery import (
    SideFiles,
    default_storage_roots,
    find_side_files,
    read_session_state,
    session_files,
    side_files_in_workspace,
    workspace_folder,
)
from agentprof.adapters.copilot_vscode.session import RawSession, load_session, parse_session_data
from agentprof.adapters.copilot_vscode.tools import is_known_tool_id
from agentprof.adapters.copilot_vscode.transcript import Transcript, load_transcript
from agentprof.adapters.copilot_vscode.tree import build_root, credits_cost
from agentprof.model import Diagnostics, Session, sum_costs
from agentprof.pricing import PriceTable

_TITLE_LENGTH = 80
_LIVE_SESSION_DIR = "chatSessions"


def _title(raw: RawSession, fallback: str) -> str:
    if raw.title:
        return raw.title
    for request in raw.requests:
        first_line = request.text.strip().splitlines()[0] if request.text.strip() else ""
        if first_line:
            return first_line[:_TITLE_LENGTH]
    return fallback


class CopilotVscodeAdapter:
    """Reads VS Code Copilot Chat sessions from `workspaceStorage`, or single exports."""

    name = "copilot-vscode"

    def __init__(self, config: AdapterConfig) -> None:
        self._usd_per_credit = PriceTable.load(config.pricing_file).usd_per_credit
        override = config.roots.get(self.name)
        if override is not None:
            self._roots = [override]
        else:
            appdata = os.environ.get("APPDATA")
            self._roots = default_storage_roots(sys.platform, Path.home(), Path(appdata) if appdata else None)

    def _ref(self, path: Path, native_id: str, side: SideFiles) -> SessionRef:
        files = [path]
        if side.transcript_file is not None:
            files.append(side.transcript_file)
        if side.debug_log_dir is not None:
            files.extend(side.debug_log_dir.glob("*.jsonl"))
        return SessionRef(agent=self.name, native_id=native_id, path=path, mtime=latest_mtime(files))

    def discover(self) -> Iterator[SessionRef]:
        for root in self._roots:
            for path in session_files(root):
                yield self._ref(path, path.stem, side_files_in_workspace(path.parent.parent, path.stem))

    def open_path(self, path: Path) -> SessionRef | None:
        if path.suffix == ".jsonl" and path.parent.name == _LIVE_SESSION_DIR and path.is_file():
            return self._ref(path, path.stem, side_files_in_workspace(path.parent.parent, path.stem))
        if path.suffix != ".json":
            return None
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict) or not isinstance(data.get("requests"), list):
            return None
        try:
            raw = parse_session_data(data)
        except (KeyError, TypeError, AttributeError):
            return None
        native_id = raw.session_id or path.stem
        return self._ref(path, native_id, find_side_files(self._roots, native_id))

    def summarize(self, ref: SessionRef) -> SessionSummary:
        if ref.path.suffix == ".jsonl":
            state = read_session_state(ref.path)
            if state is None:
                raise ValueError(f"cannot read session file {ref.path}")
            title, start_ms, credits = state.title, state.created_ms, state.credits
            last_activity_ms = state.last_activity_ms
            workspace = workspace_folder(ref.path.parent.parent)
        else:
            raw = load_session(ref.path)
            title, start_ms, credits = raw.title, raw.creation_ms, [request.credits for request in raw.requests]
            last_activity_ms = max(
                (
                    max(request.timestamp_ms, request.response_timestamp_ms or request.timestamp_ms)
                    for request in raw.requests
                ),
                default=None,
            )
            if start_ms is None and raw.requests:
                start_ms = raw.requests[0].timestamp_ms
            workspace = None
        return SessionSummary(
            id=ref.id,
            agent=self.name,
            title=title or ref.native_id,
            workspace=workspace,
            start_ms=start_ms if start_ms is not None else ref.mtime * 1000,
            end_ms=ref.mtime * 1000,
            file_size=ref.path.stat().st_size,
            last_activity_ms=last_activity_ms,
            cost_total=sum_costs([credits_cost(value, self._usd_per_credit) for value in credits]),
        )

    def analyze(self, ref: SessionRef) -> Session:
        raw = load_session(ref.path)
        is_live = ref.path.parent.name == _LIVE_SESSION_DIR
        side = self._side_files(ref, is_live)
        diagnostics = Diagnostics(malformed_lines=raw.malformed_lines)
        sources = ["live-session" if is_live else "export"]

        transcript: Transcript | None = None
        if side.transcript_file is not None:
            transcript = load_transcript(side.transcript_file)
            sources.append("transcript")
            diagnostics.malformed_lines += transcript.malformed_lines
        else:
            diagnostics.warnings.append("No transcript found: tool timings and LLM call counts are unavailable.")

        debug_log: DebugLog | None = None
        if side.debug_log_dir is not None:
            debug_log = load_debug_log_dir(side.debug_log_dir, root_session_id=side.debug_log_dir.name)
            sources.append("debug-log")
            diagnostics.malformed_lines += debug_log.malformed_lines
        else:
            diagnostics.warnings.append("No debug log found: token counts are unavailable.")

        unknown = Counter(
            tool_call.tool_id
            for request in raw.requests
            for tool_call in request.tool_calls
            if not is_known_tool_id(tool_call.tool_id)
        )
        diagnostics.unknown_tool_ids = dict(unknown)

        return Session(
            id=ref.id,
            agent=self.name,
            title=_title(raw, ref.native_id),
            workspace=workspace_folder(ref.path.parent.parent) if is_live else None,
            root=build_root(raw, transcript, debug_log, self._usd_per_credit),
            sources=sources,
            diagnostics=diagnostics,
        )

    def _side_files(self, ref: SessionRef, is_live: bool) -> SideFiles:
        if is_live:
            return side_files_in_workspace(ref.path.parent.parent, ref.native_id)
        return find_side_files(self._roots, ref.native_id)
