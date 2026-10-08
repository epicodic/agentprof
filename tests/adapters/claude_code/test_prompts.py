# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from agentprof.adapters.claude_code.prompts import prompt_topic


def test_plain_text_takes_the_first_line() -> None:
    assert prompt_topic("Fix the parser\nIt breaks on empty input") == "Fix the parser"


def test_empty_text_has_no_prompt() -> None:
    assert prompt_topic("") == "(no prompt)"


def test_strips_ide_opened_file_block() -> None:
    text = "<ide_opened_file>The user opened the file /home/u/Makefile in the IDE.</ide_opened_file>fix the build"

    assert prompt_topic(text) == "fix the build"


def test_strips_ide_selection_block() -> None:
    text = "<ide_selection>some selected code\nspanning lines</ide_selection>what does this do?"

    assert prompt_topic(text) == "what does this do?"


def test_strips_system_reminder_block() -> None:
    text = "<system-reminder>internal context\nmore context</system-reminder>continue please"

    assert prompt_topic(text) == "continue please"


def test_strips_local_command_caveat_block() -> None:
    text = "<local-command-caveat>ignore this</local-command-caveat>real prompt here"

    assert prompt_topic(text) == "real prompt here"


def test_slash_command_with_args() -> None:
    text = "<command-name>/model</command-name><command-args>sonnet</command-args>"

    assert prompt_topic(text) == "/model sonnet"


def test_slash_command_without_args() -> None:
    text = "<command-name>/compact</command-name><command-args></command-args>"

    assert prompt_topic(text) == "/compact"


def test_local_command_stdout_with_nothing_else() -> None:
    text = "<local-command-stdout>some output here</local-command-stdout>"

    assert prompt_topic(text) == "(command output)"


def test_task_notification_with_summary() -> None:
    text = "<task-notification>ignored outer text<summary>  Build finished  </summary></task-notification>"

    assert prompt_topic(text) == "Task notification: Build finished"


def test_task_notification_without_summary() -> None:
    text = "<task-notification>the agent is done</task-notification>"

    assert prompt_topic(text) == "Task notification"


def test_cuts_long_first_line_to_200_characters() -> None:
    text = "x" * 250

    assert prompt_topic(text) == "x" * 200
