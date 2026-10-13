# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from agentprof.analysis.session_index import SessionIndex
from agentprof.model import Metric, Node, NodeKind, TranscriptEntry


def _entry(entry_id: str) -> TranscriptEntry:
    return TranscriptEntry(
        entry_id=entry_id,
        owner_id="t",
        source_stream_id="s",
        source_position=0,
        block_position=0,
        timestamp=Metric.exact(0),
        kind="user_message",
        blocks=[],
    )


def _tree() -> tuple[Node, Node, Node]:
    tool = Node(node_id="tool", kind=NodeKind.TOOL, topic="read")
    turn = Node(node_id="t", kind=NodeKind.TURN, topic="t", children=[tool], transcript_entries=[_entry("e1")])
    root = Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[turn])
    return root, turn, tool


def test_index_finds_nodes_parents_and_entries() -> None:
    root, turn, tool = _tree()

    index = SessionIndex(root)

    assert index.node("tool") is tool
    assert index.node("missing") is None
    assert index.parent(tool) is turn
    assert index.parent(root) is None
    assert index.entry("e1") is turn.transcript_entries[0]
    assert index.entry("missing") is None
    assert index.nodes == [root, turn, tool]


def test_index_keeps_every_node_that_shares_an_id_in_tree_order() -> None:
    first = Node(node_id="dup", kind=NodeKind.TURN, topic="a")
    second = Node(node_id="dup", kind=NodeKind.TURN, topic="b")
    root = Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[first, second])

    index = SessionIndex(root)

    assert index.nodes_with_id("dup") == [first, second]
    assert index.node("dup") is first


def test_parent_matches_by_identity_not_equality() -> None:
    twin_a = Node(node_id="x", kind=NodeKind.TOOL, topic="same")
    twin_b = Node(node_id="x", kind=NodeKind.TOOL, topic="same")
    left = Node(node_id="l", kind=NodeKind.TURN, topic="l", children=[twin_a])
    right = Node(node_id="r", kind=NodeKind.TURN, topic="r", children=[twin_b])
    root = Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[left, right])

    assert SessionIndex(root).parent(twin_b) is right


def test_memo_computes_once_per_key_and_keeps_recent_results() -> None:
    index = SessionIndex(_tree()[0])
    calls: list[str] = []

    def compute(key: str) -> str:
        calls.append(key)
        return key.upper()

    assert index.memo("a", lambda: compute("a")) == "A"
    assert index.memo("a", lambda: compute("a")) == "A"
    assert calls == ["a"]
