# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Map Codex tool names to neutral tool categories and normalised arguments."""

import re

from agentprof.model import ToolCategory, ToolInfo

_CATEGORIES: dict[str, ToolCategory] = {
    "exec_command": ToolCategory.SHELL,
    "exec": ToolCategory.SHELL,
    "write_stdin": ToolCategory.SHELL_POLL,
    "apply_patch": ToolCategory.EDIT,
    "read_file": ToolCategory.READ,
    "web.run": ToolCategory.WEB,
    "spawn_agent": ToolCategory.SUBAGENT,
    "collaboration.spawn_agent": ToolCategory.SUBAGENT,
}

# Built-in harness tools without a dedicated category; they map to `other` but are not reported as unknown.
_KNOWN_OTHER_TOOL_IDS = {
    "collaboration.followup_task",
    "collaboration.send_message",
    "collaboration.wait_agent",
    "collaboration.interrupt_agent",
    "collaboration.list_agents",
    "create_goal",
    "get_goal",
    "update_goal",
    "wait",
    "sleep",
    "wait_agent",
    "image_gen",
    "imagegen",
    "image_gen.imagegen",
    "image_gen__imagegen",
    "request_plugin_install",
    "tool_search",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
}
_MCP_PREFIX = "mcp__"
_FILE_CATEGORIES = (ToolCategory.READ, ToolCategory.EDIT)
_PATCH_PATH = re.compile(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$", re.MULTILINE)


def _base_name(name: str) -> str:
    """Return the native name without Codex's custom-tool function namespace."""
    return name.removeprefix("functions.")


def is_known_tool_id(name: str) -> bool:
    """Whether `name` is expected; unknown names are counted in session diagnostics."""
    base_name = _base_name(name)
    return base_name in _CATEGORIES or base_name in _KNOWN_OTHER_TOOL_IDS or base_name.startswith(_MCP_PREFIX)


def _paths(arguments: dict[str, object]) -> tuple[str, ...]:
    """Return explicit file paths from native file arguments or an apply-patch payload."""
    paths: list[str] = []
    for key in ("path", "file_path", "filePath"):
        path = arguments.get(key)
        if isinstance(path, str) and path:
            paths.append(path)
            break
    argument_paths = arguments.get("paths")
    if isinstance(argument_paths, list):
        paths.extend(path for path in argument_paths if isinstance(path, str) and path)
    patch = arguments.get("patch")
    if isinstance(patch, str):
        paths.extend(
            match.group(1).strip()
            for match in _PATCH_PATH.finditer(patch.replace("\\n", "\n"))
            if match.group(1).strip()
        )
    return tuple(dict.fromkeys(paths))


def tool_info(name: str, arguments: dict[str, object]) -> ToolInfo:
    """Build the neutral `ToolInfo` for one Codex tool call."""
    base_name = _base_name(name)
    category = (
        ToolCategory.EDIT
        if base_name == "exec" and "patch" in arguments
        else _CATEGORIES.get(base_name, ToolCategory.OTHER)
    )
    paths = _paths(arguments) if category in _FILE_CATEGORIES else ()
    command = arguments.get("cmd") or arguments.get("command")
    return ToolInfo(
        native_id=name,
        category=category,
        path=paths[0] if paths else None,
        command=str(command) if isinstance(command, str) and command else None,
        arguments=arguments,
        paths=paths,
    )
