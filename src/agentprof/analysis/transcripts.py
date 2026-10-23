# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Scope, order, page and search recorded transcript entries without adapter-specific knowledge."""

import base64
import binascii
import heapq
import json
import math
from dataclasses import dataclass
from typing import Literal

from agentprof.analysis.finding_references import call_references, node_reference
from agentprof.analysis.session_index import SessionIndex
from agentprof.model import (
    ExecutionEvent,
    FindingReference,
    LlmCall,
    Node,
    NodeKind,
    TranscriptCoverage,
    TranscriptEntry,
)

_PREVIEW_LIMIT = 240


class TranscriptCursorError(ValueError):
    """A malformed cursor or one bound to a different transcript request."""


class TranscriptCursorConflict(Exception):
    """A valid cursor points to an entry that disappeared after the source changed."""


@dataclass(frozen=True)
class TranscriptHit:
    entry: TranscriptEntry
    block_position: int
    snippet: str


@dataclass(frozen=True)
class TranscriptPage:
    entries: list[TranscriptEntry]
    next_cursor: str | None
    previous_cursor: str | None
    anchor_index: int | None = None


def scope_entries(
    index: SessionIndex,
    node_id: str | None = None,
    *,
    call_key: str | None = None,
    event_id: str | None = None,
) -> list[TranscriptEntry]:
    """Select entries visible in a session, root, turn, agent or tool invocation scope, in transcript order.

    The result is memoised on `index` per scope, so callers must not change it.
    """
    if call_key is not None and event_id is not None:
        raise ValueError("call_key and event_id are mutually exclusive")
    return index.memo(
        ("scope_entries", node_id, call_key, event_id),
        lambda: _scope_entries(index, node_id, call_key, event_id),
    )


def _scope_entries(
    index: SessionIndex, node_id: str | None, call_key: str | None, event_id: str | None
) -> list[TranscriptEntry]:
    selected, invocation_keys = _scope_nodes(index, node_id)
    entries = [entry for node in selected if node is not None for entry in node.transcript_entries]
    if node_id is not None and index.nodes_with_id(node_id)[0].kind is NodeKind.TOOL:
        entries = [entry for entry in entries if entry.invocation_id in invocation_keys]
    references_by_entry: dict[int, list[FindingReference]] = {}
    if call_key is not None or event_id is not None:
        references_by_entry = _supporting_reference_index(index, entries)
    if call_key is not None:
        entries = [
            entry
            for entry in entries
            if any(
                ref.kind == "call" and ref.owner_id == node_id and ref.key == call_key
                for ref in references_by_entry[id(entry)]
            )
        ]
    if event_id is not None:
        entries = [
            entry
            for entry in entries
            if any(
                ref.kind == "event" and ref.owner_id == node_id and ref.key == event_id
                for ref in references_by_entry[id(entry)]
            )
        ]
    return ordered_entries(entries)


def _scope_nodes(index: SessionIndex, node_id: str | None) -> tuple[list[Node], set[str]]:
    if node_id is None:
        return index.nodes, set()
    owners = index.nodes_with_id(node_id)
    if len(owners) != 1:
        raise KeyError(node_id)
    owner = owners[0]
    if owner.kind is NodeKind.TOOL:
        parent = index.parent(owner)
        return ([parent] if parent is not None else []), {owner.node_id}
    if owner.kind is NodeKind.TURN:
        return [owner], set()
    if owner.kind is NodeKind.SESSION:
        return [owner, *_main_turns(owner)], set()
    return [owner, *_owned_turns(owner)], set()


def scope_coverage(index: SessionIndex, node_id: str | None = None) -> TranscriptCoverage:
    """Coverage reported by nodes included in the selected scope."""
    nodes, _ = _scope_nodes(index, node_id)
    return transcript_coverage(nodes)


def _main_turns(root: Node) -> list[Node]:
    turns: list[Node] = []
    for child in root.children:
        if child.kind is NodeKind.TURN:
            turns.append(child)
    return turns


def _owned_turns(owner: Node) -> list[Node]:
    turns: list[Node] = []

    def visit(node: Node) -> None:
        if node.kind is NodeKind.AGENT:
            return
        if node.kind is NodeKind.TURN:
            turns.append(node)
            return
        for child in node.children:
            visit(child)

    for child in owner.children:
        visit(child)
    return turns


def ordered_entries(entries: list[TranscriptEntry]) -> list[TranscriptEntry]:
    """Merge source-stream heads by timestamp, retaining physical and block order in each stream."""
    streams: dict[str, list[TranscriptEntry]] = {}
    for entry in entries:
        streams.setdefault(entry.source_stream_id, []).append(entry)
    for stream in streams.values():
        stream.sort(key=lambda entry: (entry.source_position, entry.block_position))
    offsets = {stream_id: 0 for stream_id in streams}
    heads: list[tuple[bool, float, str, int, int, int, TranscriptEntry]] = []
    sequence = 0
    for stream_id, stream in streams.items():
        entry = stream[0]
        timestamp = entry.timestamp.value
        heapq.heappush(
            heads,
            (
                timestamp is None,
                float(timestamp) if timestamp is not None else math.inf,
                stream_id,
                entry.source_position,
                entry.block_position,
                sequence,
                entry,
            ),
        )
        sequence += 1
    ordered: list[TranscriptEntry] = []
    while heads:
        _, _, stream_id, _, _, _, entry = heapq.heappop(heads)
        ordered.append(entry)
        offsets[stream_id] += 1
        if offsets[stream_id] < len(streams[stream_id]):
            next_entry = streams[stream_id][offsets[stream_id]]
            timestamp = next_entry.timestamp.value
            heapq.heappush(
                heads,
                (
                    timestamp is None,
                    float(timestamp) if timestamp is not None else math.inf,
                    stream_id,
                    next_entry.source_position,
                    next_entry.block_position,
                    sequence,
                    next_entry,
                ),
            )
            sequence += 1
    return ordered


def transcript_coverage(nodes: list[Node]) -> TranscriptCoverage:
    """Combine scoped coverage and explain when no adapter recorded a transcript source."""
    coverages = [node.transcript_coverage for node in nodes]
    source_present = any(coverage.source_present for coverage in coverages) or any(
        node.transcript_entries for node in nodes
    )
    categories = list(dict.fromkeys(category for coverage in coverages for category in coverage.categories))
    reasons = list(dict.fromkeys(reason for coverage in coverages for reason in coverage.reasons))
    if not source_present and not reasons:
        reasons.append("No recorded transcript source")
    return TranscriptCoverage(source_present, categories, reasons)


def preview(entry: TranscriptEntry) -> str | None:
    """Return bounded recorded text only, omitting structured data and unreadable bodies."""
    text = next(
        (
            block.text
            for block in entry.blocks
            if block.text is not None and block.availability in {"recorded", "truncated"}
        ),
        None,
    )
    return text[:_PREVIEW_LIMIT] if text is not None else None


def search_entries(entries: list[TranscriptEntry], query: str) -> list[TranscriptHit]:
    """Find a literal case-insensitive phrase in recorded text or serialized readable structured data.

    `entries` must be in transcript order, as `scope_entries` returns them; hits keep that order.
    """
    needle = query.casefold()
    if not needle.strip():
        raise ValueError("query must not be blank")
    hits: list[TranscriptHit] = []
    for entry in entries:
        for position, block in enumerate(entry.blocks):
            candidates: list[str] = []
            if block.availability in {"recorded", "truncated"} and block.text is not None:
                candidates.append(block.text)
            if block.data is not None and block.availability not in {"encrypted", "unavailable"}:
                candidates.append(json.dumps(block.data, ensure_ascii=False, sort_keys=True, default=str))
            matched = next((candidate for candidate in candidates if needle in candidate.casefold()), None)
            if matched is not None:
                hits.append(TranscriptHit(entry, position, _snippet(matched, needle)))
                break
    return hits


def _snippet(text: str, needle: str) -> str:
    lowered = text.casefold()
    folded_start = lowered.find(needle)
    folded_end = folded_start + len(needle)
    folded_position = 0
    start = 0
    end = len(text)
    for index, char in enumerate(text):
        next_position = folded_position + len(char.casefold())
        if folded_position <= folded_start < next_position:
            start = index
        if folded_position < folded_end <= next_position:
            end = index + 1
            break
        folded_position = next_position
    room = _PREVIEW_LIMIT - int(start > 0) - int(end < len(text))
    left = max(0, start - max(0, room - (end - start)) // 2)
    right = min(len(text), left + room)
    if right < end:
        right = end
        left = max(0, right - room)
    if right - left > room:
        left = max(0, start)
        right = min(len(text), left + room)
    snippet = text[left:right]
    return ("…" if left else "") + snippet + ("…" if right < len(text) else "")


def supporting_references(index: SessionIndex, entry: TranscriptEntry) -> list[FindingReference]:
    """Resolve only unique exact IDs on the owning logical agent stream."""
    return _supporting_reference_index(index, [entry])[id(entry)]


@dataclass
class _OwnerReferenceLookup:
    calls_by_request: dict[tuple[str | None, str], list[LlmCall]]
    call_references: dict[int, FindingReference]
    events_by_id: dict[str, list[ExecutionEvent]]
    tools_by_id: dict[str, list[Node]]


def _supporting_reference_index(
    index: SessionIndex, entries: list[TranscriptEntry]
) -> dict[int, list[FindingReference]]:
    """Index tree identities and each referenced owner once for a transcript selection."""
    owner_lookups: dict[str, _OwnerReferenceLookup] = {}
    references_by_entry: dict[int, list[FindingReference]] = {}
    for entry in entries:
        owners = index.nodes_with_id(entry.owner_id)
        if len(owners) != 1:
            references_by_entry[id(entry)] = []
            continue
        owner = owners[0]
        lookup = owner_lookups.get(owner.node_id)
        if lookup is None:
            lookup = _owner_reference_lookup(owner)
            owner_lookups[owner.node_id] = lookup
        references: list[FindingReference] = []
        if entry.source_request_id is not None:
            stream_id = entry.logical_stream_id or entry.source_stream_id
            calls = lookup.calls_by_request.get((stream_id, entry.source_request_id), [])
            if len(calls) == 1:
                reference = lookup.call_references.get(id(calls[0]))
                if reference is not None:
                    references.append(reference)
        if entry.invocation_id is not None:
            tools = lookup.tools_by_id.get(entry.invocation_id, [])
            if len(tools) == 1:
                references.append(node_reference(tools[0]))
        if entry.event_id is not None:
            event_streams = {entry.source_stream_id}
            if entry.logical_stream_id is not None:
                event_streams.add(entry.logical_stream_id)
            events = lookup.events_by_id.get(entry.event_id, [])
            if len(events) == 1 and events[0].source_stream_id in event_streams:
                references.append(FindingReference("event", owner.node_id, entry.event_id, events[0].kind))
        if entry.subject_node_id is not None:
            subjects = index.nodes_with_id(entry.subject_node_id)
            if len(subjects) == 1:
                references.append(node_reference(subjects[0]))
        references_by_entry[id(entry)] = list(
            {(reference.kind, reference.owner_id, reference.key): reference for reference in references}.values()
        )
    return references_by_entry


def _owner_reference_lookup(owner: Node) -> _OwnerReferenceLookup:
    """Precompute exact call, event and direct tool identities for one owner."""
    calls_by_request: dict[tuple[str | None, str], list[LlmCall]] = {}
    for call in owner.llm_calls:
        if call.source_request_id is not None:
            calls_by_request.setdefault((call.source_stream_id, call.source_request_id), []).append(call)
    events_by_id: dict[str, list[ExecutionEvent]] = {}
    for event in owner.execution_events:
        if event.event_id:
            events_by_id.setdefault(event.event_id, []).append(event)
    tools_by_id: dict[str, list[Node]] = {}
    for child in owner.children:
        if child.kind is NodeKind.TOOL:
            tools_by_id.setdefault(child.node_id, []).append(child)
    return _OwnerReferenceLookup(calls_by_request, call_references(owner), events_by_id, tools_by_id)


def encode_cursor(
    *,
    session_id: str,
    scope_id: str | None,
    query: str | None,
    call_key: str | None,
    event_id: str | None,
    last_entry_id: str,
    direction: Literal["next", "previous"] = "next",
) -> str:
    """Encode a stateless cursor bound to the complete selection request."""
    payload = {
        "s": session_id,
        "o": scope_id,
        "q": query,
        "c": call_key,
        "e": event_id,
        "i": last_entry_id,
        "d": direction,
    }
    return base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")


def decode_cursor(
    cursor: str,
    *,
    session_id: str,
    scope_id: str | None,
    query: str | None,
    call_key: str | None,
    event_id: str | None,
) -> tuple[str, Literal["next", "previous"]]:
    """Validate and decode a cursor, rejecting malformed or cross-scope reuse."""
    try:
        raw = base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True)
        payload = json.loads(raw)
    except (binascii.Error, ValueError, json.JSONDecodeError) as error:
        raise TranscriptCursorError("malformed transcript cursor") from error
    expected = {"s": session_id, "o": scope_id, "q": query, "c": call_key, "e": event_id}
    if not isinstance(payload, dict) or any(payload.get(key) != value for key, value in expected.items()):
        raise TranscriptCursorError("transcript cursor does not match this request")
    entry_id = payload.get("i")
    direction = payload.get("d")
    if (
        not isinstance(entry_id, str)
        or not entry_id
        or not isinstance(direction, str)
        or direction not in {"next", "previous"}
    ):
        raise TranscriptCursorError("malformed transcript cursor")
    return entry_id, direction


def page_entries(
    entries: list[TranscriptEntry],
    *,
    limit: int,
    session_id: str,
    scope_id: str | None,
    query: str | None = None,
    call_key: str | None = None,
    event_id: str | None = None,
    after: str | None = None,
    anchor: str | None = None,
) -> TranscriptPage:
    """Return a bounded page or centered anchor context with stable previous and next cursors.

    `entries` must be in transcript order, as `scope_entries` and `search_entries` return them.
    """
    ordered = entries
    ids = [entry.entry_id for entry in ordered]
    anchor_index: int | None = None
    if anchor is not None:
        if anchor not in ids:
            raise KeyError(anchor)
        anchor_index = ids.index(anchor)
        selected_anchor_index = anchor_index
        start = max(0, min(anchor_index - limit // 2, len(ordered) - limit))
    elif after is not None:
        cursor_id, direction = decode_cursor(
            after,
            session_id=session_id,
            scope_id=scope_id,
            query=query,
            call_key=call_key,
            event_id=event_id,
        )
        if cursor_id not in ids:
            raise TranscriptCursorConflict("Transcript changed; refresh to load current entries.")
        cursor_index = ids.index(cursor_id)
        start = max(0, cursor_index - limit) if direction == "previous" else cursor_index + 1
    else:
        start = 0
    page = ordered[start : start + limit]
    next_cursor = None
    previous_cursor = None
    if page and start + len(page) < len(ordered):
        next_cursor = encode_cursor(
            session_id=session_id,
            scope_id=scope_id,
            query=query,
            call_key=call_key,
            event_id=event_id,
            last_entry_id=page[-1].entry_id,
        )
    if page and start > 0:
        previous_cursor = encode_cursor(
            session_id=session_id,
            scope_id=scope_id,
            query=query,
            call_key=call_key,
            event_id=event_id,
            last_entry_id=page[0].entry_id,
            direction="previous",
        )
    if anchor_index is not None:
        anchor_index = selected_anchor_index - start
    return TranscriptPage(page, next_cursor, previous_cursor, anchor_index)
