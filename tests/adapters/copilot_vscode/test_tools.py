# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import pytest

from agentprof.adapters.copilot_vscode.tools import is_known_tool_id, is_subagent_tool_id, tool_info
from agentprof.model import ToolCategory, ToolInfo


@pytest.mark.parametrize(
    ("tool_id", "category"),
    [
        ("copilot_readFile", ToolCategory.READ),
        ("read_file", ToolCategory.READ),
        ("copilot_replaceString", ToolCategory.EDIT),
        ("copilot_createFile", ToolCategory.EDIT),
        ("copilot_findTextInFiles", ToolCategory.SEARCH),
        ("copilot_listDirectory", ToolCategory.SEARCH),
        ("run_in_terminal", ToolCategory.SHELL),
        ("get_terminal_output", ToolCategory.SHELL_POLL),
        ("send_to_terminal", ToolCategory.SHELL_POLL),
        ("copilot_fetchWebPage", ToolCategory.WEB),
        ("runSubagent", ToolCategory.SUBAGENT),
        ("execution_subagent", ToolCategory.SUBAGENT),
        ("manage_todo_list", ToolCategory.OTHER),
        ("something_new", ToolCategory.OTHER),
        ("vscode_renameSymbol", ToolCategory.EDIT),
        ("vscode_listCodeUsages", ToolCategory.SEARCH),
        ("copilot_getChangedFiles", ToolCategory.SEARCH),
        ("Run in Terminal", ToolCategory.SHELL),
        ("copilot_viewImage", ToolCategory.READ),
        ("kill_terminal", ToolCategory.OTHER),
    ],
)
def test_tool_info_maps_native_ids_to_categories(tool_id: str, category: ToolCategory) -> None:
    assert tool_info(tool_id, {}).category is category


def test_tool_info_normalises_read_path_and_line_range() -> None:
    arguments: dict[str, object] = {"filePath": "/repo/foo.py", "startLine": 10, "endLine": 40}

    assert tool_info("copilot_readFile", arguments) == ToolInfo(
        native_id="copilot_readFile",
        category=ToolCategory.READ,
        path="/repo/foo.py",
        line_range=(10, 40),
        arguments=arguments,
    )


def test_tool_info_leaves_normalised_fields_empty_without_arguments() -> None:
    info = tool_info("copilot_readFile", {})

    assert info.path is None
    assert info.line_range is None


def test_tool_info_normalises_edit_path_and_shell_command() -> None:
    assert tool_info("copilot_replaceString", {"filePath": "a.py"}).path == "a.py"
    assert tool_info("run_in_terminal", {"command": "pytest -x"}).command == "pytest -x"


def test_tool_info_lists_every_file_of_a_multi_replace() -> None:
    arguments: dict[str, object] = {
        "replacements": [{"filePath": "a.py"}, {"filePath": "b.py"}, {"filePath": "a.py"}, {"oldString": "x"}]
    }

    info = tool_info("copilot_multiReplaceString", arguments)

    assert info.path == "a.py"
    assert info.paths == ("a.py", "b.py")


def test_tool_info_ignores_paths_for_non_file_categories() -> None:
    assert tool_info("copilot_listDirectory", {"path": "/repo"}).path is None


def test_is_subagent_tool_id() -> None:
    assert is_subagent_tool_id("runSubagent")
    assert is_subagent_tool_id("search_subagent")
    assert not is_subagent_tool_id("run_in_terminal")


def test_is_known_tool_id_accepts_mapped_other_and_mcp_tools() -> None:
    assert is_known_tool_id("copilot_readFile")
    assert is_known_tool_id("manage_todo_list")
    assert is_known_tool_id("mcp_serena_find_symbol")
    assert is_known_tool_id("execution_subagent")
    assert not is_known_tool_id("something_new")


def test_is_known_tool_id_accepts_known_other_ids_and_github_pull_request_prefix() -> None:
    assert is_known_tool_id("kill_terminal")
    assert is_known_tool_id("github-pull-request_create_pull_request")


def test_tool_info_marks_tools_that_write_whole_files() -> None:
    assert tool_info("copilot_createFile", {"filePath": "a.py"}).writes_file
    assert tool_info("create_file", {"filePath": "a.py"}).writes_file
    assert not tool_info("copilot_replaceString", {"filePath": "a.py"}).writes_file
