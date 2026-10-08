# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Map Copilot tool ids to neutral tool categories and normalised arguments.

Copilot uses two names per tool: the `toolId` in the session file (e.g. `copilot_readFile`) and the function
name in `toolCallRounds` and the transcript (e.g. `read_file`). Both are mapped.
"""

from agentprof.model import ToolCategory, ToolInfo

_CATEGORIES: dict[str, ToolCategory] = {
    "copilot_readFile": ToolCategory.READ,
    "read_file": ToolCategory.READ,
    "copilot_replaceString": ToolCategory.EDIT,
    "replace_string_in_file": ToolCategory.EDIT,
    "copilot_multiReplaceString": ToolCategory.EDIT,
    "multi_replace_string_in_file": ToolCategory.EDIT,
    "copilot_createFile": ToolCategory.EDIT,
    "create_file": ToolCategory.EDIT,
    "copilot_applyPatch": ToolCategory.EDIT,
    "apply_patch": ToolCategory.EDIT,
    "copilot_insertEdit": ToolCategory.EDIT,
    "insert_edit_into_file": ToolCategory.EDIT,
    "copilot_findTextInFiles": ToolCategory.SEARCH,
    "grep_search": ToolCategory.SEARCH,
    "copilot_findFiles": ToolCategory.SEARCH,
    "file_search": ToolCategory.SEARCH,
    "copilot_listDirectory": ToolCategory.SEARCH,
    "list_dir": ToolCategory.SEARCH,
    "copilot_searchCodebase": ToolCategory.SEARCH,
    "semantic_search": ToolCategory.SEARCH,
    "run_in_terminal": ToolCategory.SHELL,
    "run_task": ToolCategory.SHELL,
    "runTests": ToolCategory.SHELL,
    "get_terminal_output": ToolCategory.SHELL_POLL,
    "send_to_terminal": ToolCategory.SHELL_POLL,
    "terminal_last_command": ToolCategory.SHELL_POLL,
    "copilot_fetchWebPage": ToolCategory.WEB,
    "fetch_webpage": ToolCategory.WEB,
    "vscode_fetchWebPage_internal": ToolCategory.WEB,
    "vscode_renameSymbol": ToolCategory.EDIT,
    "vscode_listCodeUsages": ToolCategory.SEARCH,
    "copilot_getChangedFiles": ToolCategory.SEARCH,
    "Run in Terminal": ToolCategory.SHELL,
    "copilot_viewImage": ToolCategory.READ,
}

# Expected tools without a dedicated category; they map to `other` but are not reported as unknown.
_KNOWN_OTHER_TOOL_IDS = {
    "manage_todo_list",
    "tool_search",
    "vscode_askQuestions",
    "copilot_getErrors",
    "get_errors",
    "copilot_memory",
    "copilot_sessionStoreSql",
    "kill_terminal",
    "configure_python_environment",
    "copilot_runVscodeCommand",
    "run_playwright_code",
    "screenshot_page",
    "open_browser_page",
}
_MCP_PREFIX = "mcp_"
_GITHUB_PULL_REQUEST_PREFIX = "github-pull-request_"
_FILE_CATEGORIES = (ToolCategory.READ, ToolCategory.EDIT)
_WHOLE_FILE_WRITERS = {"copilot_createFile", "create_file"}


def is_subagent_tool_id(tool_id: str) -> bool:
    """Whether `tool_id` always denotes a subagent dispatch."""
    return tool_id == "runSubagent" or tool_id.endswith("_subagent")


def is_known_tool_id(tool_id: str) -> bool:
    """Whether `tool_id` is expected; unknown ids are counted in the session diagnostics."""
    return (
        tool_id in _CATEGORIES
        or tool_id in _KNOWN_OTHER_TOOL_IDS
        or tool_id.startswith(_MCP_PREFIX)
        or tool_id.startswith(_GITHUB_PULL_REQUEST_PREFIX)
        or is_subagent_tool_id(tool_id)
    )


def _category(tool_id: str) -> ToolCategory:
    if is_subagent_tool_id(tool_id):
        return ToolCategory.SUBAGENT
    return _CATEGORIES.get(tool_id, ToolCategory.OTHER)


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _paths(arguments: dict[str, object]) -> tuple[str, ...]:
    """The files named by the arguments: a top-level path, or each `replacements` entry's (multi-replace)."""
    path = arguments.get("filePath") or arguments.get("path")
    if path:
        return (str(path),)
    replacements = arguments.get("replacements")
    if not isinstance(replacements, list):
        return ()
    paths = (entry.get("filePath") for entry in replacements if isinstance(entry, dict))
    return tuple(dict.fromkeys(str(path) for path in paths if path))


def tool_info(tool_id: str, arguments: dict[str, object]) -> ToolInfo:
    """Build the neutral `ToolInfo` for one Copilot tool call."""
    category = _category(tool_id)
    paths = _paths(arguments) if category in _FILE_CATEGORIES else ()
    start_line = _int_or_none(arguments.get("startLine"))
    end_line = _int_or_none(arguments.get("endLine"))
    command = arguments.get("command")
    line_range = None
    if category is ToolCategory.READ and start_line is not None and end_line is not None:
        line_range = (start_line, end_line)
    return ToolInfo(
        native_id=tool_id,
        category=category,
        path=paths[0] if paths else None,
        line_range=line_range,
        command=str(command) if command and category is ToolCategory.SHELL else None,
        writes_file=tool_id in _WHOLE_FILE_WRITERS,
        arguments=arguments,
        paths=paths,
    )
