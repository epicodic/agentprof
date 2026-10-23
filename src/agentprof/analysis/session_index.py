# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Lookups over one analysed session, built once and shared by the requests that read it."""

import threading
from collections import OrderedDict
from collections.abc import Callable, Hashable
from typing import cast

from agentprof.model import Node, TranscriptEntry, iter_nodes

_MEMO_SIZE = 64


class SessionIndex:
    """Node, parent and transcript-entry lookups for one analysed tree, plus a small memo for derived values.

    The tree must not change after the index is built.
    Lookups by id return the first match in depth-first order, like a scan of `iter_nodes`.
    """

    def __init__(self, root: Node) -> None:
        self.root = root
        self.nodes: list[Node] = list(iter_nodes(root))
        """Every node, depth first."""
        self._by_id: dict[str, list[Node]] = {}
        self._parents: dict[int, Node] = {}
        self._entries: dict[str, TranscriptEntry] = {}
        for node in self.nodes:
            self._by_id.setdefault(node.node_id, []).append(node)
            for child in node.children:
                self._parents[id(child)] = node
            for entry in node.transcript_entries:
                self._entries.setdefault(entry.entry_id, entry)
        self._memo: OrderedDict[Hashable, object] = OrderedDict()
        self._lock = threading.Lock()

    def node(self, node_id: str) -> Node | None:
        """The first node with `node_id`, or `None`."""
        nodes = self._by_id.get(node_id)
        return nodes[0] if nodes else None

    def nodes_with_id(self, node_id: str) -> list[Node]:
        """Every node with `node_id`, depth first."""
        return list(self._by_id.get(node_id, ()))

    def parent(self, node: Node) -> Node | None:
        """The node whose `children` hold `node` (by identity), or `None` for the root."""
        return self._parents.get(id(node))

    def entry(self, entry_id: str) -> TranscriptEntry | None:
        """The first transcript entry with `entry_id`, or `None`."""
        return self._entries.get(entry_id)

    def memo[T](self, key: Hashable, compute: Callable[[], T]) -> T:
        """`compute()` once per `key`; keeps the `_MEMO_SIZE` most recently used results.

        Callers must not change a returned value.
        An exception from `compute` is raised and nothing is stored.
        """
        with self._lock:
            if key in self._memo:
                self._memo.move_to_end(key)
                return cast(T, self._memo[key])
        value = compute()
        with self._lock:
            self._memo[key] = value
            self._memo.move_to_end(key)
            while len(self._memo) > _MEMO_SIZE:
                self._memo.popitem(last=False)
        return value
