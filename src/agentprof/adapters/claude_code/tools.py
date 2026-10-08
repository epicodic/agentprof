# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Map Claude Code tool names to neutral tool categories and normalised arguments."""

from agentprof.model import ToolCategory, ToolInfo

_CATEGORIES: dict[str, ToolCategory] = {
    "Read": ToolCategory.READ,
    "Edit": ToolCategory.EDIT,
    "Write": ToolCategory.EDIT,
    "NotebookEdit": ToolCategory.EDIT,
    "Grep": ToolCategory.SEARCH,
    "Glob": ToolCategory.SEARCH,
    "Bash": ToolCategory.SHELL,
    "BashOutput": ToolCategory.SHELL_POLL,
    "TaskOutput": ToolCategory.SHELL_POLL,
    "Monitor": ToolCategory.SHELL_POLL,
    "WebFetch": ToolCategory.WEB,
    "WebSearch": ToolCategory.WEB,
    "Agent": ToolCategory.SUBAGENT,
    "Task": ToolCategory.SUBAGENT,
}

# Built-in harness tools without a dedicated category; they map to `other` but are not reported as unknown.
_KNOWN_OTHER_TOOL_IDS = {
    "AskUserQuestion",
    "ToolSearch",
    "Skill",
    "SendMessage",
    "ListAgents",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskGet",
    "TaskStop",
    "KillShell",
    "TodoWrite",
    "EnterPlanMode",
    "ExitPlanMode",
    "EnterWorktree",
    "ExitWorktree",
    "ScheduleWakeup",
    "CronCreate",
    "CronDelete",
    "CronList",
    "PushNotification",
    "RemoteTrigger",
    "ReadNotifications",
    "SendUserFile",
    "SlashCommand",
    "LSP",
    "Artifact",
    "ArtifactComments",
    "ArtifactData",
    "ReportFindings",
    "SendFeedback",
}
_CATEGORIES_CASEFOLDED = {name.casefold(): category for name, category in _CATEGORIES.items()}
_KNOWN_OTHER_TOOL_IDS_CASEFOLDED = {name.casefold() for name in _KNOWN_OTHER_TOOL_IDS}
_MCP_PREFIX = "mcp__"
_FILE_CATEGORIES = (ToolCategory.READ, ToolCategory.EDIT)
_WHOLE_FILE_WRITERS = {"write"}


def is_known_tool_id(name: str) -> bool:
    """Whether `name` is expected; unknown names are counted in the session diagnostics."""
    normalized = name.casefold()
    return (
        normalized in _CATEGORIES_CASEFOLDED
        or normalized in _KNOWN_OTHER_TOOL_IDS_CASEFOLDED
        or normalized.startswith(_MCP_PREFIX)
    )


def _positive_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _line_range(arguments: dict[str, object]) -> tuple[int, int] | None:
    """`Read` takes a 1-based start line `offset` and a line count `limit`; without both it may read the whole file."""
    offset = _positive_int(arguments.get("offset"))
    limit = _positive_int(arguments.get("limit"))
    if limit is None:
        return None
    start = offset or 1
    return (start, start + limit - 1)


def tool_info(name: str, arguments: dict[str, object]) -> ToolInfo:
    """Build the neutral `ToolInfo` for one Claude Code tool call."""
    category = _CATEGORIES_CASEFOLDED.get(name.casefold(), ToolCategory.OTHER)
    path = arguments.get("file_path") or arguments.get("notebook_path")
    command = arguments.get("command")
    return ToolInfo(
        native_id=name,
        category=category,
        path=str(path) if path and category in _FILE_CATEGORIES else None,
        line_range=_line_range(arguments) if category is ToolCategory.READ else None,
        command=str(command) if command and category is ToolCategory.SHELL else None,
        writes_file=name.casefold() in _WHOLE_FILE_WRITERS,
        arguments=arguments,
    )
