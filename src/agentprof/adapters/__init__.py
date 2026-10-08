# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Agent adapters: turn agent-specific session files into the neutral model."""

from importlib.metadata import entry_points

from agentprof.adapters.base import AdapterConfig, AgentAdapter

ENTRY_POINT_GROUP = "agentprof.adapters"


def load_adapters(config: AdapterConfig) -> list[AgentAdapter]:
    """Instantiate every adapter registered under the `agentprof.adapters` entry point group."""
    registered = sorted(entry_points(group=ENTRY_POINT_GROUP), key=lambda entry_point: entry_point.name)
    return [entry_point.load()(config) for entry_point in registered]
