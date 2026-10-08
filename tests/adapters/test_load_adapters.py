# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from pathlib import Path

from agentprof.adapters import load_adapters
from agentprof.adapters.base import AdapterConfig
from agentprof.adapters.codex.adapter import CodexAdapter
from agentprof.adapters.copilot_vscode.adapter import CopilotVscodeAdapter


def test_load_adapters_instantiates_registered_adapters_with_the_config(copilot_storage: Path) -> None:
    adapters = load_adapters(AdapterConfig(roots={"copilot-vscode": copilot_storage}))

    copilot = next(adapter for adapter in adapters if adapter.name == "copilot-vscode")
    assert isinstance(copilot, CopilotVscodeAdapter)
    assert [ref.native_id for ref in copilot.discover()] == ["session_basic_001"]


def test_load_adapters_includes_claude_code() -> None:
    names = [adapter.name for adapter in load_adapters(AdapterConfig())]

    assert names == ["claude-code", "codex", "copilot-vscode"]


def test_load_adapters_includes_codex() -> None:
    adapters = load_adapters(AdapterConfig())

    assert isinstance(next(adapter for adapter in adapters if adapter.name == "codex"), CodexAdapter)
