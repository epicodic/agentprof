# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Locate Copilot session files and read the few fields the session list needs, cheaply."""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

_PRODUCTS = ("Code", "Code - Insiders")

# The only patch lines that change the summary; everything else is skipped without JSON-parsing it.
_SUMMARY_PATCH = re.compile(r'\{"kind":\s*[12],\s*"k":\s*\["(requests|customTitle)"\]')
_CREDITS_PATCH = re.compile(r'\{"kind":\s*1,\s*"k":\s*\["requests",\s*(\d+),\s*"copilotCredits"\]')
_ACTIVITY_PATCH = re.compile(r'\{"kind":\s*1,\s*"k":\s*\["requests",\s*(\d+),\s*"(timestamp|responseTimestamp)"\]')


@dataclass(frozen=True)
class SideFiles:
    """Optional sources that belong to one session."""

    transcript_file: Path | None
    debug_log_dir: Path | None


@dataclass
class SessionState:
    """Summary fields of a live session file; `credits` holds each request's `copilotCredits`, if known yet."""

    created_ms: float | None
    title: str
    credits: list[float | None]
    activity_ms: list[float | None]

    @property
    def last_activity_ms(self) -> float | None:
        return max((value for value in self.activity_ms if value is not None), default=None)


def _credits_of(requests: list[dict[str, Any]]) -> list[float | None]:
    return [request.get("copilotCredits") for request in requests]


def _activity_of(requests: list[dict[str, Any]]) -> list[float | None]:
    return [
        max(
            (value for key in ("timestamp", "responseTimestamp") if (value := request.get(key)) is not None),
            default=None,
        )
        for request in requests
    ]


def default_storage_roots(platform: str, home: Path, appdata: Path | None) -> list[Path]:
    """The `workspaceStorage` directories of VS Code and VS Code Insiders on `platform` (`sys.platform`)."""
    if platform == "darwin":
        base = home / "Library" / "Application Support"
    elif platform == "win32":
        if appdata is None:
            return []
        base = appdata
    else:
        base = home / ".config"
    return [base / product / "User" / "workspaceStorage" for product in _PRODUCTS]


def session_files(root: Path) -> list[Path]:
    """All live session files under one `workspaceStorage` root."""
    return sorted(root.glob("*/chatSessions/*.jsonl"))


def workspace_folder(workspace_dir: Path) -> str | None:
    """The folder a workspace storage directory belongs to, from its `workspace.json`."""
    workspace_json = workspace_dir / "workspace.json"
    if not workspace_json.is_file():
        return None
    try:
        folder_uri = json.loads(workspace_json.read_text()).get("folder")
    except json.JSONDecodeError:
        return None
    if not folder_uri:
        return None
    return urlparse(folder_uri).path


def read_session_state(session_file: Path) -> SessionState | None:
    """Read the snapshot line plus the request, title and credit patches, or `None` if the file is malformed."""
    with session_file.open() as lines:
        try:
            snapshot = json.loads(next(lines, ""))["v"]
        except (json.JSONDecodeError, KeyError, TypeError):
            return None
        state = SessionState(
            created_ms=snapshot.get("creationDate"),
            title=str(snapshot.get("customTitle", "")),
            credits=_credits_of(snapshot.get("requests", [])),
            activity_ms=_activity_of(snapshot.get("requests", [])),
        )
        for line in lines:
            _apply_summary_patch(state, line)
    return state


def _apply_summary_patch(state: SessionState, line: str) -> None:
    summary, credits, activity = _SUMMARY_PATCH.match(line), _CREDITS_PATCH.match(line), _ACTIVITY_PATCH.match(line)
    if summary is None and credits is None and activity is None:
        return
    try:
        patch = json.loads(line)
    except json.JSONDecodeError:
        return  # in-progress write of the last line
    if credits is not None:
        index = int(credits.group(1))
        if index < len(state.credits):
            state.credits[index] = patch["v"]
    elif activity is not None:
        index = int(activity.group(1))
        if index < len(state.activity_ms):
            state.activity_ms[index] = max(state.activity_ms[index] or patch["v"], patch["v"])
    elif summary is not None and summary.group(1) == "customTitle":
        state.title = str(patch["v"])
    elif patch["kind"] == 1:
        state.credits = _credits_of(patch["v"])
        state.activity_ms = _activity_of(patch["v"])
    else:
        start = patch.get("i")
        state.credits[len(state.credits) if start is None else start :] = _credits_of(patch["v"])
        state.activity_ms[len(state.activity_ms) if start is None else start :] = _activity_of(patch["v"])


def side_files_in_workspace(workspace_dir: Path, session_id: str) -> SideFiles:
    """Transcript and debug log of `session_id` inside one workspace storage directory."""
    copilot_dir = workspace_dir / "GitHub.copilot-chat"
    transcript_file = copilot_dir / "transcripts" / f"{session_id}.jsonl"
    debug_log_dir = copilot_dir / "debug-logs" / session_id
    return SideFiles(
        transcript_file=transcript_file if transcript_file.is_file() else None,
        debug_log_dir=debug_log_dir if debug_log_dir.is_dir() else None,
    )


def find_side_files(roots: list[Path], session_id: str) -> SideFiles:
    """Search every workspace under `roots` for the transcript and debug log of `session_id`."""
    for root in roots:
        if not root.is_dir():
            continue
        for workspace_dir in sorted(path for path in root.iterdir() if path.is_dir()):
            side = side_files_in_workspace(workspace_dir, session_id)
            if side.transcript_file is not None or side.debug_log_dir is not None:
                return side
    return SideFiles(transcript_file=None, debug_log_dir=None)
