# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import pytest

from agentprof.adapters.claude_code.tools import is_known_tool_id, tool_info
from agentprof.model import ToolCategory, ToolInfo


@pytest.mark.parametrize(
    ("name", "category"),
    [
        ("Read", ToolCategory.READ),
        ("Edit", ToolCategory.EDIT),
        ("Write", ToolCategory.EDIT),
        ("NotebookEdit", ToolCategory.EDIT),
        ("Grep", ToolCategory.SEARCH),
        ("Glob", ToolCategory.SEARCH),
        ("Bash", ToolCategory.SHELL),
        ("BashOutput", ToolCategory.SHELL_POLL),
        ("TaskOutput", ToolCategory.SHELL_POLL),
        ("Monitor", ToolCategory.SHELL_POLL),
        ("WebFetch", ToolCategory.WEB),
        ("WebSearch", ToolCategory.WEB),
        ("Agent", ToolCategory.SUBAGENT),
        ("Task", ToolCategory.SUBAGENT),
        ("AskUserQuestion", ToolCategory.OTHER),
        ("mcp__serena__find_symbol", ToolCategory.OTHER),
    ],
)
def test_tool_info_maps_tool_names_to_categories(name: str, category: ToolCategory) -> None:
    assert tool_info(name, {}).category is category


def test_tool_info_turns_offset_and_limit_into_a_line_range() -> None:
    arguments: dict[str, object] = {"file_path": "/repo/a.py", "offset": 10, "limit": 20}

    assert tool_info("Read", arguments) == ToolInfo(
        native_id="Read", category=ToolCategory.READ, path="/repo/a.py", line_range=(10, 29), arguments=arguments
    )


def test_tool_info_reads_the_file_start_when_only_limit_is_given() -> None:
    assert tool_info("Read", {"file_path": "a.py", "limit": 5}).line_range == (1, 5)


def test_tool_info_has_no_line_range_for_a_whole_file_read() -> None:
    assert tool_info("Read", {"file_path": "a.py"}).line_range is None


def test_tool_info_normalises_edit_paths_and_shell_commands() -> None:
    assert tool_info("Edit", {"file_path": "a.py"}).path == "a.py"
    assert tool_info("NotebookEdit", {"notebook_path": "n.ipynb"}).path == "n.ipynb"
    assert tool_info("Bash", {"command": "uv run pytest"}).command == "uv run pytest"
    assert tool_info("Grep", {"path": "/repo"}).path is None


def test_is_known_tool_id() -> None:
    assert is_known_tool_id("Read")
    assert is_known_tool_id("AskUserQuestion")
    assert is_known_tool_id("ReportFindings")
    assert is_known_tool_id("mcp__plugin_serena_serena__find_symbol")
    assert not is_known_tool_id("FancyNewTool")


def test_known_tool_names_are_case_insensitive_but_native_ids_are_preserved() -> None:
    info = tool_info("rEaD", {"file_path": "a.py", "limit": 5})

    assert is_known_tool_id("aSkUsErQuEsTiOn")
    assert is_known_tool_id("MCP__serena__find_symbol")
    assert info.native_id == "rEaD"
    assert info.category is ToolCategory.READ
    assert info.path == "a.py"
    assert info.line_range == (1, 5)
    assert tool_info("wRiTe", {"file_path": "a.py"}).writes_file


def test_tool_info_marks_tools_that_write_whole_files() -> None:
    assert tool_info("Write", {"file_path": "a.py"}).writes_file
    assert not tool_info("Edit", {"file_path": "a.py"}).writes_file
    assert not tool_info("Read", {"file_path": "a.py"}).writes_file
