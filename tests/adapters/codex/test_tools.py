# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Tests for Codex tool normalisation."""

import pytest

from agentprof.adapters.codex.tools import is_known_tool_id, tool_info
from agentprof.model import ToolCategory


@pytest.mark.parametrize(
    ("name", "category"),
    [
        ("exec_command", ToolCategory.SHELL),
        ("functions.exec_command", ToolCategory.SHELL),
        ("exec", ToolCategory.SHELL),
        ("functions.exec", ToolCategory.SHELL),
        ("write_stdin", ToolCategory.SHELL_POLL),
        ("functions.write_stdin", ToolCategory.SHELL_POLL),
        ("apply_patch", ToolCategory.EDIT),
        ("read_file", ToolCategory.READ),
        ("web.run", ToolCategory.WEB),
        ("spawn_agent", ToolCategory.SUBAGENT),
        ("collaboration.spawn_agent", ToolCategory.SUBAGENT),
    ],
)
def test_tool_info_maps_codex_tool_names(name: str, category: ToolCategory) -> None:
    assert tool_info(name, {}).category is category
    assert is_known_tool_id(name)


def test_tool_info_normalises_shell_command_and_preserves_raw_arguments() -> None:
    arguments: dict[str, object] = {"cmd": "rg --files", "yield_time_ms": 10_000}

    info = tool_info("functions.exec_command", arguments)

    assert info.native_id == "functions.exec_command"
    assert info.command == "rg --files"
    assert info.arguments is arguments
    assert info.path is None


def test_tool_info_extracts_explicit_paths_from_file_and_patch_arguments() -> None:
    read = tool_info("read_file", {"path": "docs/guide.md"})
    patch = tool_info(
        "apply_patch",
        {
            "patch": "*** Begin Patch\n*** Update File: src/main.py\n*** Add File: tests/test_main.py\n*** End Patch",
        },
    )

    assert read.paths == ("docs/guide.md",)
    assert read.path == "docs/guide.md"
    assert patch.paths == ("src/main.py", "tests/test_main.py")
    assert patch.path == "src/main.py"


def test_apply_patch_does_not_mark_a_whole_file_write() -> None:
    assert not tool_info("apply_patch", {"patch": "*** Begin Patch\n*** End Patch"}).writes_file


@pytest.mark.parametrize(
    "name",
    [
        "collaboration.followup_task",
        "wait_agent",
        "image_gen__imagegen",
        "request_plugin_install",
    ],
)
def test_known_meta_tools_map_to_other_without_being_unknown(name: str) -> None:
    assert tool_info(name, {}).category is ToolCategory.OTHER
    assert is_known_tool_id(name)


def test_unknown_tool_maps_to_other_but_is_not_known() -> None:
    assert tool_info("future_unmapped_tool", {}).category is ToolCategory.OTHER
    assert not is_known_tool_id("future_unmapped_tool")
