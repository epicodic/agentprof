# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from agentprof.adapters.copilot_vscode.session import clean_topic, load_session, parse_export, parse_session_data

_FIXTURES = Path(__file__).parent / "fixtures"


def _export_data() -> dict[str, Any]:
    return json.loads((_FIXTURES / "export_basic.json").read_text())


def test_parse_export_extracts_one_request_with_five_tool_calls() -> None:
    requests = parse_export(_export_data())

    assert len(requests) == 1
    request = requests[0]
    assert request.request_id == "request_001"
    assert request.text == "do the thing"
    assert request.session_id == "session_basic_001"
    assert request.credits == 42.0
    assert request.prompt_tokens == 1000
    assert request.completion_tokens == 200
    assert request.time_spent_waiting_ms == 0
    assert request.elapsed_ms == 5000
    assert [tc.tool_call_id for tc in request.tool_calls] == [
        "call_read_main",
        "call_lead",
        "call_exec",
        "call_read_child",
        "call_term_child",
    ]


def test_parse_export_reads_subagent_fields_from_tool_specific_data() -> None:
    requests = parse_export(_export_data())

    lead = next(tc for tc in requests[0].tool_calls if tc.tool_call_id == "call_lead")
    assert lead.subagent_description == "Dispatch Activity Lead"
    assert lead.subagent_model == "Claude Sonnet 5"
    assert lead.subagent_credits == 12.5
    assert lead.parent_tool_call_id is None

    child = next(tc for tc in requests[0].tool_calls if tc.tool_call_id == "call_exec")
    assert child.parent_tool_call_id == "call_lead"
    assert child.subagent_credits is None


def test_parse_export_marks_agent_nodes_by_children_not_just_tool_id() -> None:
    requests = parse_export(_export_data())

    by_id = {tc.tool_call_id: tc for tc in requests[0].tool_calls}
    # execution_subagent carries no toolSpecificData, but another tool call names it as a parent.
    assert by_id["call_exec"].is_agent is True
    assert by_id["call_read_child"].is_agent is False


def test_parse_export_handles_two_levels_of_runsubagent_nesting() -> None:
    requests = parse_export(json.loads((_FIXTURES / "nested_subagent.json").read_text()))

    by_id = {tc.tool_call_id: tc for tc in requests[0].tool_calls}
    assert by_id["call_a"].is_agent is True
    assert by_id["call_a"].parent_tool_call_id is None
    assert by_id["call_b"].is_agent is True
    assert by_id["call_b"].parent_tool_call_id == "call_a"


def test_parse_export_skips_response_parts_without_a_tool_call_id() -> None:
    data = _export_data()
    data["requests"][0]["response"].insert(0, {"kind": "thinking", "text": "reasoning..."})

    requests = parse_export(data)

    assert len(requests[0].tool_calls) == 5


def test_parse_export_reads_arguments_from_the_matching_tool_call_round() -> None:
    requests = parse_export(_export_data())

    by_id = {tc.tool_call_id: tc for tc in requests[0].tool_calls}
    assert by_id["call_read_main"].arguments == {"filePath": "foo.py"}
    assert by_id["call_lead"].arguments == {}
    # Nested-subagent tool calls never appear in the top-level request's own toolCallRounds.
    assert by_id["call_exec"].arguments == {}
    assert by_id["call_read_child"].arguments == {}


def test_parse_export_strips_the_vscode_suffix_from_round_tool_call_ids() -> None:
    data = _export_data()
    round_ = data["requests"][0]["result"]["metadata"]["toolCallRounds"][0]
    round_["toolCalls"][0]["id"] = "call_read_main__vscode-1779116386890"

    requests = parse_export(data)

    by_id = {tc.tool_call_id: tc for tc in requests[0].tool_calls}
    assert by_id["call_read_main"].arguments == {"filePath": "foo.py"}


def test_load_session_reports_session_id_title_and_creation_date() -> None:
    raw = load_session(_FIXTURES / "export_basic.json")

    assert raw.session_id == "session_basic_001"
    assert raw.title == ""
    assert raw.creation_ms is None
    assert raw.malformed_lines == 0


def test_parse_session_data_reads_custom_title_and_creation_date() -> None:
    data = _export_data()
    data["customTitle"] = "My title"
    data["creationDate"] = 1790123000000

    raw = parse_session_data(data)

    assert raw.title == "My title"
    assert raw.creation_ms == 1790123000000


def test_replayed_live_session_matches_the_equivalent_export() -> None:
    expected = load_session(_FIXTURES / "export_basic.json").requests

    actual = load_session(_FIXTURES / "live_session_patches.jsonl").requests

    assert len(actual) == len(expected) == 1
    assert actual[0].request_id == expected[0].request_id
    assert actual[0].credits == expected[0].credits == 42.0
    assert actual[0].completion_tokens == expected[0].completion_tokens == 200
    assert [tc.tool_call_id for tc in actual[0].tool_calls] == [tc.tool_call_id for tc in expected[0].tool_calls]
    lead = next(tc for tc in actual[0].tool_calls if tc.tool_call_id == "call_lead")
    assert lead.subagent_credits == 12.5


def test_live_session_skips_and_counts_a_malformed_line(tmp_path: Path) -> None:
    lines = (_FIXTURES / "live_session_patches.jsonl").read_text().splitlines()
    path = tmp_path / "live.jsonl"
    path.write_text("\n".join([*lines, '{"kind": 1, "k": ["requ']) + "\n")

    raw = load_session(path)

    assert raw.malformed_lines == 1
    assert len(raw.requests) == 1


def test_live_session_without_a_snapshot_raises(tmp_path: Path) -> None:
    path = tmp_path / "live.jsonl"
    path.write_text('{"kind": 1, "k": ["customTitle"], "v": "x"}\n')

    with pytest.raises(ValueError, match="snapshot"):
        load_session(path)


def test_parse_export_deduplicates_re_serialized_tool_calls() -> None:
    data = _export_data()
    duplicate_lead = copy.deepcopy(data["requests"][0]["response"][1])
    duplicate_lead["invocationMessage"] = "Dispatch Activity Lead (updated)"
    data["requests"][0]["response"].append(duplicate_lead)

    requests = parse_export(data)

    assert [tc.tool_call_id for tc in requests[0].tool_calls] == [
        "call_read_main",
        "call_lead",
        "call_exec",
        "call_read_child",
        "call_term_child",
    ]
    lead = next(tc for tc in requests[0].tool_calls if tc.tool_call_id == "call_lead")
    assert lead.topic == "Dispatch Activity Lead (updated)"


def test_live_session_truncating_splice_without_a_value(tmp_path: Path) -> None:
    data = _export_data()
    first_request = data["requests"][0]
    second_request = copy.deepcopy(first_request)
    second_request["requestId"] = "request_002"
    data["requests"] = [first_request, second_request]

    lines = [
        json.dumps({"kind": 0, "v": data}),
        json.dumps({"kind": 2, "k": ["requests"], "i": 1}),
    ]
    path = tmp_path / "live.jsonl"
    path.write_text("\n".join(lines) + "\n")

    raw = load_session(path)

    assert len(raw.requests) == 1


def test_live_session_decodes_concatenated_records_on_one_line(tmp_path: Path) -> None:
    snapshot = {"kind": 0, "v": _export_data()}
    patch = {"kind": 1, "k": ["customTitle"], "v": "Joined"}
    path = tmp_path / "live.jsonl"
    path.write_text(json.dumps(snapshot) + json.dumps(patch))

    raw = load_session(path)

    assert raw.title == "Joined"
    assert raw.malformed_lines == 0


def test_live_session_counts_a_patch_targeting_a_missing_index_as_malformed(tmp_path: Path) -> None:
    lines = (_FIXTURES / "live_session_patches.jsonl").read_text().splitlines()
    bad_patch = json.dumps({"kind": 1, "k": ["requests", 5, "result"], "v": {}})
    path = tmp_path / "live.jsonl"
    path.write_text("\n".join([*lines, bad_patch]) + "\n")

    raw = load_session(path)

    assert raw.malformed_lines == 1
    assert len(raw.requests) == 1


def test_parse_session_data_removes_a_tool_call_already_seen_in_an_earlier_request() -> None:
    data = _export_data()
    second = copy.deepcopy(data["requests"][0])
    second["requestId"] = "request_002"
    second["timestamp"] = data["requests"][0]["timestamp"] + 60_000
    data["requests"].append(second)

    raw = parse_session_data(data)

    assert len(raw.requests[0].tool_calls) == 5
    assert raw.requests[1].tool_calls == []


def test_clean_topic_leaves_plain_text_unchanged() -> None:
    assert clean_topic("Running a terminal command") == "Running a terminal command"


def test_clean_topic_link_with_empty_label_uses_the_file_path() -> None:
    text = "Reading [](file:///home/u/repo/src/app.py)"

    assert clean_topic(text) == "Reading /home/u/repo/src/app.py"


def test_clean_topic_link_with_label_uses_the_label() -> None:
    text = "Reading skill [git-commit](file:///home/u/.agents/skills/git-commit/SKILL.md)"

    assert clean_topic(text) == "Reading skill git-commit"


def test_clean_topic_link_drops_the_line_fragment() -> None:
    text = "Reading [](file:///home/u/repo/src/app.py#L10-L20)"

    assert clean_topic(text) == "Reading /home/u/repo/src/app.py"


def test_clean_topic_link_decodes_percent_encoding() -> None:
    text = "Reading [](file:///home/u/my%20repo/app.py)"

    assert clean_topic(text) == "Reading /home/u/my repo/app.py"


def test_clean_topic_removes_backslash_escapes_but_keeps_backticks() -> None:
    text = "Running `git diff \\-\\-cached`"

    assert clean_topic(text) == "Running `git diff --cached`"


def test_clean_topic_removes_escaped_backticks_and_pipes() -> None:
    text = "Searching for text \\`a\\|b\\`"

    assert clean_topic(text) == "Searching for text `a|b`"


def test_clean_topic_link_with_non_file_target_and_empty_label_uses_the_target() -> None:
    text = "See [](https://example.com/docs)"

    assert clean_topic(text) == "See https://example.com/docs"
