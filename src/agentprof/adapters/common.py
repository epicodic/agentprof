# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Helpers shared by the adapters: JSONL reading with malformed-line details, first-line topics and titles."""

import json
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agentprof.model import MalformedLineDetail

TITLE_LENGTH = 80
_MAX_MALFORMED_LINE_DETAILS = 20
_MAX_EXCERPT_LENGTH = 120
_NOT_AN_OBJECT = "line is not a JSON object"


def first_line(text: str, limit: int) -> str:
    """The first non-blank line of `text`, stripped and cut to `limit` characters."""
    return next((line.strip()[:limit] for line in text.splitlines() if line.strip()), "")


def title_from_prompts(
    prompts: Iterable[str],
    fallback: str,
    topic: Callable[[str], str] | None = None,
    limit: int = TITLE_LENGTH,
) -> str:
    """The topic of the first prompt that has one, cut to `limit`; `fallback` if none has.

    `topic` maps a prompt to its topic, or to `""` when it has none; it defaults to the prompt's first line.
    """
    for prompt in prompts:
        title = (topic(prompt) if topic is not None else first_line(prompt, limit))[:limit]
        if title:
            return title
    return fallback


def _redacted_excerpt(line: str) -> str:
    """Retain short JSON syntax shape while removing all string and scalar contents."""
    parts: list[str] = []
    in_string = False
    escaped = False
    redacting_scalar = False
    for char in line[:_MAX_EXCERPT_LENGTH]:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                parts.append('"')
                in_string = False
            continue
        if char == '"':
            parts.append('"[redacted]')
            in_string = True
            redacting_scalar = False
        elif char in "{}[]:,":
            parts.append(char)
            redacting_scalar = False
        elif char.isspace():
            parts.append(" ")
            redacting_scalar = False
        elif not redacting_scalar:
            parts.append("[redacted]")
            redacting_scalar = True
    excerpt = "".join(parts)
    if len(line) > _MAX_EXCERPT_LENGTH:
        return excerpt[: _MAX_EXCERPT_LENGTH - 1] + "…"
    return excerpt[:_MAX_EXCERPT_LENGTH]


def _error_category(error: Exception) -> str:
    """The coarse, content-free category of a line-decoding or line-processing error."""
    if isinstance(error, json.JSONDecodeError):
        return "invalid_json"
    if isinstance(error, KeyError):
        return "missing_field"
    if isinstance(error, TypeError) and str(error).endswith(_NOT_AN_OBJECT):
        return "non_object"
    if isinstance(error, (TypeError, AttributeError)):
        return "invalid_type"
    return "invalid_value"


@dataclass
class MalformedLines:
    """Counts malformed source lines and keeps redacted details of the first few."""

    count: int = 0
    details: list[MalformedLineDetail] = field(default_factory=list)

    def add(self, path: Path, line_number: int, text: str, error: Exception) -> None:
        """Count one malformed line; keep its detail while fewer than the limit are kept."""
        self.count += 1
        if len(self.details) < _MAX_MALFORMED_LINE_DETAILS:
            self.details.append(
                MalformedLineDetail(
                    source_path=str(path),
                    line_number=line_number,
                    excerpt=_redacted_excerpt(text.rstrip("\r\n")),
                    error_category=_error_category(error),
                )
            )


@dataclass(frozen=True)
class JsonlLine:
    """One JSON-object line: its 1-based physical line number, its text and its decoded value."""

    number: int
    text: str
    value: dict[str, Any]


def iter_jsonl(path: Path, malformed: MalformedLines) -> Iterator[JsonlLine]:
    """Yield the JSON-object lines of `path`; blank lines are skipped, undecodable or non-object lines recorded.

    Lines are physical (`\\n`-separated) and decoded as UTF-8 one by one.
    A caller that fails to process a yielded line records it with `malformed.add(path, line.number, line.text, error)`.
    Raises `OSError` when the file cannot be opened.
    """
    with path.open("rb") as source:
        for number, raw in enumerate(source, start=1):
            if not raw.strip():
                continue
            text = raw.decode("utf-8", errors="replace")
            try:
                value = json.loads(raw.decode("utf-8"))
                if not isinstance(value, dict):
                    raise TypeError(_NOT_AN_OBJECT)
            except (json.JSONDecodeError, TypeError, ValueError) as error:
                malformed.add(path, number, text, error)
                continue
            yield JsonlLine(number, text, value)
