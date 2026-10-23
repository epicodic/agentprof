# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Typed API responses for transcript windows, search hits and explicit entry details."""

from typing import Any

from pydantic import BaseModel

from agentprof.analysis.session_index import SessionIndex
from agentprof.analysis.transcripts import TranscriptHit, preview, scope_coverage, supporting_references
from agentprof.model import (
    TranscriptAvailability,
    TranscriptBlock,
    TranscriptCoverage,
    TranscriptEntry,
    TranscriptKind,
)
from agentprof.server.schemas import FindingReferenceOut, MetricOut


class TranscriptCoverageOut(BaseModel):
    source_present: bool
    categories: list[str]
    reasons: list[str]


class TranscriptEntryOut(BaseModel):
    entry_id: str
    owner_id: str
    source_stream_id: str
    source_position: int
    block_position: int
    native_id: str | None
    native_ordinal: int | None
    timestamp: MetricOut
    kind: TranscriptKind
    role: str | None
    sender: str | None = None
    recipient: str | None = None
    channel: str | None
    ownership_evidence: str | None
    preview: str | None
    block_availability: list[TranscriptAvailability]


class TranscriptBlockOut(BaseModel):
    kind: str
    native_type: str | None
    text: str | None
    data: Any | None
    availability: TranscriptAvailability


class TranscriptEntryDetailOut(TranscriptEntryOut):
    blocks: list[TranscriptBlockOut]
    coverage: TranscriptCoverageOut
    logical_stream_id: str | None
    source_request_id: str | None
    invocation_id: str | None
    event_id: str | None
    subject_node_id: str | None
    references: list[FindingReferenceOut]


class TranscriptPageOut(BaseModel):
    session_id: str
    scope_id: str | None
    mtime: float
    revision: str
    coverage: TranscriptCoverageOut
    entries: list[TranscriptEntryOut]
    next_cursor: str | None
    previous_cursor: str | None
    anchor_index: int | None


class TranscriptSearchHitOut(BaseModel):
    entry_id: str
    owner_id: str
    kind: str
    role: str | None
    sender: str | None = None
    recipient: str | None = None
    ownership_evidence: str | None = None
    channel: str | None
    timestamp: MetricOut
    block_position: int
    snippet: str


class TranscriptSearchOut(BaseModel):
    session_id: str
    scope_id: str | None
    mtime: float
    revision: str
    coverage: TranscriptCoverageOut
    hits: list[TranscriptSearchHitOut]
    next_cursor: str | None
    previous_cursor: str | None


def coverage_out(coverage: TranscriptCoverage) -> TranscriptCoverageOut:
    return TranscriptCoverageOut(
        source_present=coverage.source_present,
        categories=coverage.categories,
        reasons=coverage.reasons[:20],
    )


def transcript_entry_out(entry: TranscriptEntry) -> TranscriptEntryOut:
    return TranscriptEntryOut(
        entry_id=entry.entry_id,
        owner_id=entry.owner_id,
        source_stream_id=entry.source_stream_id,
        source_position=entry.source_position,
        block_position=entry.block_position,
        native_id=entry.native_id,
        native_ordinal=entry.native_ordinal,
        timestamp=entry.timestamp,
        kind=entry.kind,
        role=entry.role,
        sender=entry.sender[:240] if entry.sender is not None else None,
        recipient=entry.recipient[:240] if entry.recipient is not None else None,
        channel=entry.channel,
        ownership_evidence=entry.ownership_evidence,
        preview=preview(entry),
        block_availability=list(dict.fromkeys(block.availability for block in entry.blocks)),
    )


def transcript_detail_out(index: SessionIndex, entry: TranscriptEntry) -> TranscriptEntryDetailOut:
    return TranscriptEntryDetailOut(
        **transcript_entry_out(entry).model_dump(),
        blocks=[transcript_block_out(block) for block in entry.blocks],
        coverage=coverage_out(scope_coverage(index, entry.owner_id)),
        logical_stream_id=entry.logical_stream_id,
        source_request_id=entry.source_request_id,
        invocation_id=entry.invocation_id,
        event_id=entry.event_id,
        subject_node_id=entry.subject_node_id,
        references=supporting_references(index, entry),
    )


def transcript_block_out(block: TranscriptBlock) -> TranscriptBlockOut:
    encrypted = block.availability == "encrypted"
    return TranscriptBlockOut(
        kind=block.kind,
        native_type=block.native_type,
        text=None if encrypted else block.text,
        data=None if encrypted else block.data,
        availability=block.availability,
    )


def transcript_hit_out(hit: TranscriptHit) -> TranscriptSearchHitOut:
    entry = hit.entry
    return TranscriptSearchHitOut(
        entry_id=entry.entry_id,
        owner_id=entry.owner_id,
        kind=entry.kind,
        role=entry.role,
        sender=entry.sender[:240] if entry.sender is not None else None,
        recipient=entry.recipient[:240] if entry.recipient is not None else None,
        ownership_evidence=entry.ownership_evidence,
        channel=entry.channel,
        timestamp=entry.timestamp,
        block_position=hit.block_position,
        snippet=hit.snippet,
    )
