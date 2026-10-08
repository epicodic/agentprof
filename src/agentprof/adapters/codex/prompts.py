# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Derive compact topics from Codex user prompts."""

NO_PROMPT = "(no prompt)"
_TOPIC_LENGTH = 200


def first_line(text: str, limit: int = _TOPIC_LENGTH) -> str:
    """Return the first non-empty prompt line, stripped and bounded."""
    return next((line.strip()[:limit] for line in text.splitlines() if line.strip()), "")


def prompt_topic(prompt: str | None) -> str:
    """Return a human-readable topic for a Codex turn prompt."""
    return first_line(prompt) if prompt else NO_PROMPT
