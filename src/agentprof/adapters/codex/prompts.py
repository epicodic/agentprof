# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Derive compact topics from Codex user prompts."""

from agentprof.adapters.common import first_line

NO_PROMPT = "(no prompt)"
_TOPIC_LENGTH = 200


def prompt_topic(prompt: str | None) -> str:
    """Return a human-readable topic for a Codex turn prompt."""
    return first_line(prompt, _TOPIC_LENGTH) if prompt else NO_PROMPT
