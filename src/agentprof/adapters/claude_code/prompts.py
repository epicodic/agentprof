# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Derive a short, human-readable topic from a Claude Code turn prompt."""

import re

NO_PROMPT = "(no prompt)"
_TOPIC_LENGTH = 200
_BLOCK_TAGS = ("ide_opened_file", "ide_selection", "system-reminder", "local-command-caveat")
_BLOCK_RE = re.compile("|".join(rf"<{tag}>.*?</{tag}>" for tag in _BLOCK_TAGS), re.DOTALL)
_COMMAND_RE = re.compile(r"<command-name>(.*?)</command-name>(?:<command-args>(.*?)</command-args>)?", re.DOTALL)
_LOCAL_COMMAND_STDOUT_RE = re.compile(r"<local-command-stdout>.*?</local-command-stdout>", re.DOTALL)
_TASK_NOTIFICATION_RE = re.compile(r"<task-notification>(.*?)</task-notification>", re.DOTALL)
_SUMMARY_RE = re.compile(r"<summary>(.*?)</summary>", re.DOTALL)


def first_line(text: str, limit: int) -> str:
    """The first non-blank line of `text`, stripped and cut to `limit` characters."""
    return next((line.strip()[:limit] for line in text.splitlines() if line.strip()), "")


def prompt_topic(text: str) -> str:
    """A short topic for a turn prompt, stripping IDE/harness context and special markup."""
    stripped = _BLOCK_RE.sub("", text)

    command_match = _COMMAND_RE.search(stripped)
    if command_match is not None:
        name = command_match.group(1).strip()
        args = (command_match.group(2) or "").strip()
        return f"{name} {args}" if args else name

    without_stdout = _LOCAL_COMMAND_STDOUT_RE.sub("", stripped)
    if without_stdout != stripped and not without_stdout.strip():
        return "(command output)"
    stripped = without_stdout

    notification_match = _TASK_NOTIFICATION_RE.search(stripped)
    if notification_match is not None:
        summary_match = _SUMMARY_RE.search(notification_match.group(1))
        if summary_match is not None:
            return f"Task notification: {summary_match.group(1).strip()}"
        return "Task notification"

    return first_line(stripped, _TOPIC_LENGTH) or NO_PROMPT
