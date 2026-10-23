# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import json
from pathlib import Path

from agentprof.adapters.common import MalformedLines, first_line, iter_jsonl, title_from_prompts


def test_first_line_skips_blank_lines_and_truncates() -> None:
    assert first_line("\n  hello world  \nsecond", 5) == "hello"
    assert first_line("  \n ", 5) == ""


def test_title_from_prompts_takes_the_first_prompt_with_a_topic() -> None:
    assert title_from_prompts(["  ", "\n second prompt \nmore"], "fallback", limit=6) == "second"
    assert title_from_prompts([], "fallback") == "fallback"
    assert title_from_prompts(["x"], "fallback", topic=lambda text: "") == "fallback"


def test_iter_jsonl_yields_objects_and_records_malformed_lines(tmp_path: Path) -> None:
    path = tmp_path / "s.jsonl"
    path.write_bytes(
        json.dumps({"a": 1}).encode()
        + b"\n\n"
        + b'{"broken\n'
        + b"[1, 2]\n"
        + b"\xff\xfe\n"
        + b'{"b": "\xe2\x80\xa8"}\r\n'
    )
    malformed = MalformedLines()

    lines = list(iter_jsonl(path, malformed))

    assert [(line.number, line.value) for line in lines] == [(1, {"a": 1}), (6, {"b": " "})]
    assert malformed.count == 3
    assert [(detail.line_number, detail.error_category) for detail in malformed.details] == [
        (3, "invalid_json"),
        (4, "non_object"),
        (5, "invalid_value"),
    ]
    assert all(detail.source_path == str(path) for detail in malformed.details)


def test_malformed_lines_keeps_the_first_twenty_details_and_counts_all(tmp_path: Path) -> None:
    malformed = MalformedLines()
    for number in range(1, 26):
        malformed.add(tmp_path / "s.jsonl", number, '{"secret": "value"}', KeyError("x"))

    assert malformed.count == 25
    assert len(malformed.details) == 20
    assert malformed.details[0].error_category == "missing_field"
    assert "value" not in malformed.details[0].excerpt
