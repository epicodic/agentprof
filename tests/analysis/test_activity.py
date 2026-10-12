# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from agentprof.analysis.activity import NodeActivity, node_activity
from agentprof.model import Metric, Node, NodeKind


def test_open_agent_is_running_and_its_callers_are_waiting() -> None:
    agent = Node(node_id="a", kind=NodeKind.AGENT, topic="a", start=Metric.exact(10), end=Metric.estimated(50))
    tool = Node(
        node_id="t", kind=NodeKind.TOOL, topic="t", start=Metric.exact(5), end=Metric.exact(50), children=[agent]
    )
    turn = Node(
        node_id="u", kind=NodeKind.TURN, topic="u", start=Metric.exact(1), end=Metric.exact(50), children=[tool]
    )
    root = Node(
        node_id="s", kind=NodeKind.SESSION, topic="s", start=Metric.exact(1), end=Metric.exact(50), children=[turn]
    )

    activity = node_activity(root)

    assert activity[id(agent)] == NodeActivity(active=True, active_descendant=False, activity="running")
    assert activity[id(tool)] == NodeActivity(active=False, active_descendant=True, activity=None)
    assert activity[id(turn)] == NodeActivity(active=False, active_descendant=True, activity="waiting")
    assert activity[id(root)] == NodeActivity(active=False, active_descendant=True, activity=None)


def test_node_overtaken_by_later_activity_is_not_active() -> None:
    old = Node(node_id="a", kind=NodeKind.AGENT, topic="a", start=Metric.exact(10), end=Metric.estimated(20))
    later = Node(node_id="u", kind=NodeKind.TURN, topic="u", start=Metric.exact(30), end=Metric.exact(90))
    root = Node(
        node_id="s",
        kind=NodeKind.SESSION,
        topic="s",
        start=Metric.exact(1),
        end=Metric.exact(90),
        children=[old, later],
    )

    assert node_activity(root)[id(old)].active is False
