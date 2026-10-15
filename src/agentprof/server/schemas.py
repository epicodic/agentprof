# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""API response models and their mapping from the neutral model and registry rows."""

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from agentprof.analysis.activity import NodeActivity, node_activity
from agentprof.analysis.agent_summary import agent_groups, agent_ids
from agentprof.model import (
    CallLinkEvidence,
    CallLinkRelation,
    ExecutionEventKind,
    FindingReferenceKind,
    Node,
    NodeKind,
    Session,
    TimingBasis,
)
from agentprof.registry import RowState, SessionRow


class _FromModel(BaseModel):
    """A response model whose fields equal the neutral model's attributes; Pydantic reads them from the object."""

    model_config = ConfigDict(from_attributes=True)


class MetricOut(_FromModel):
    value: float | None
    provenance: str


class CostOut(_FromModel):
    value: float | None
    unit: str | None
    usd: float | None
    provenance: str


class TokensOut(_FromModel):
    input: MetricOut
    output: MetricOut
    cache_read: MetricOut
    cache_write: MetricOut
    cache_write_5m: MetricOut
    cache_write_1h: MetricOut


class ToolOut(_FromModel):
    native_id: str
    category: str
    path: str | None
    paths: list[str]
    line_range: tuple[int, int] | None
    command: str | None
    writes_file: bool
    target_agent_id: str | None
    is_resume: bool
    linked_agent_node_id: str | None


class LlmCallOut(_FromModel):
    call_id: str | None
    start: MetricOut
    duration: MetricOut
    model: str | None
    tokens: TokensOut
    cost: CostOut
    in_context: bool
    cost_parts: dict[str, CostOut]
    price_prefix: str | None
    gap: MetricOut
    gap_basis: str | None
    preceding_events: list["CallEventOut"]
    cold_reason: str
    cold_rewrite: bool
    source_request_id: str | None = None
    source_order: int | None = None
    source_stream_id: str | None = None
    timing_basis: TimingBasis = "unknown"
    call_key: str | None = None


class CallEventOut(_FromModel):
    kind: str
    event_id: str
    start: MetricOut
    end: MetricOut
    duration: MetricOut


class EventCallLinkOut(_FromModel):
    source_request_id: str
    relation: CallLinkRelation
    evidence: CallLinkEvidence
    owner_id: str | None = None


class ExecutionEventOut(_FromModel):
    kind: ExecutionEventKind
    event_id: str | None = None
    subject_node_id: str | None = None
    start: MetricOut
    source_order: int | None = None
    source_stream_id: str | None = None
    success: bool | None = None
    links: list[EventCallLinkOut]
    execution_start: MetricOut
    execution_end: MetricOut


class FindingReferenceOut(_FromModel):
    kind: FindingReferenceKind
    owner_id: str
    key: str
    label: str


class FindingOut(_FromModel):
    heuristic_id: str
    node_id: str
    severity: str
    message: str
    evidence: dict[str, Any]
    estimated_avoidable_cost: CostOut
    references: list[FindingReferenceOut] = Field(default_factory=list)
    observed_cost: CostOut = Field(default_factory=lambda: CostOut(value=None, unit=None, usd=None, provenance="n/a"))
    avoidable_cost_baseline: str | None = None
    rank: int | None = None


class NodeOut(BaseModel):
    node_id: str
    agent_id: int | None
    harness_agent_id: str | None
    active: bool
    active_descendant: bool
    activity: str | None
    kind: str
    topic: str
    model: str | None
    success: bool | None
    tool: ToolOut | None
    start: MetricOut
    end: MetricOut
    duration: MetricOut
    user_wait: MetricOut
    llm_call_count: MetricOut
    tool_call_count: MetricOut
    tokens: TokensOut
    tokens_total: TokensOut
    cost_total: CostOut
    cost_own: CostOut
    context_peak: MetricOut
    compactions: list[MetricOut]
    resume_times: list[MetricOut]
    llm_calls: list[LlmCallOut]
    execution_events: list[ExecutionEventOut] = Field(default_factory=list)
    findings: list[FindingOut]
    children: list["NodeOut"]


class DiagnosticsOut(_FromModel):
    malformed_lines: int
    unknown_tool_ids: dict[str, int]
    warnings: list[str]


class MalformedLineDetailOut(_FromModel):
    source_path: str
    line_number: int
    excerpt: str
    error_category: str


class DiagnosticsDetailOut(DiagnosticsOut):
    malformed_line_details: list[MalformedLineDetailOut]


class AgentSummaryRowOut(_FromModel):
    agent_id: int
    harness_agent_id: str | None
    parent_agent_id: int | None
    topic: str
    models: list[str]
    llm_calls: MetricOut
    duration: MetricOut
    tokens_in_out: MetricOut
    context_peak: MetricOut
    tokens: TokensOut
    own_cost: CostOut
    subtree_cost: CostOut
    start: MetricOut
    end: MetricOut
    cost_parts: dict[str, CostOut]
    cache_ttl: str
    cold_rewrites: MetricOut
    cold_rewrite_cost: CostOut
    longest_gap: MetricOut
    findings_count: int
    resume_count: int


class SessionOut(BaseModel):
    id: str
    agent: str
    title: str
    workspace: str | None
    mtime: float
    sources: list[str]
    diagnostics: DiagnosticsOut
    agents: list[AgentSummaryRowOut]
    root: NodeOut


class ProjectedNodeOut(NodeOut):
    """A tree node in a bounded response; children may be omitted by depth."""

    children: list["ProjectedNodeOut"]
    children_omitted: bool | None = None


class ProjectedSessionOut(BaseModel):
    """Optional top-level groups selected with the `fields` query parameter."""

    id: str | None = None
    agent: str | None = None
    title: str | None = None
    workspace: str | None = None
    mtime: float | None = None
    sources: list[str] | None = None
    diagnostics: DiagnosticsOut | None = None
    root: ProjectedNodeOut | None = None


class NodeDetailOut(BaseModel):
    node_id: str
    prompt: str
    result: str
    arguments: dict[str, Any]


class SummaryOut(BaseModel):
    id: str
    agent: str
    title: str
    workspace: str | None
    state: str
    mtime: float
    start_ms: float | None
    last_activity_ms: float | None
    end_ms: float | None
    file_size: int | None
    cost_total: CostOut | None
    error: str | None


class ApiEndpointOut(BaseModel):
    method: str
    path: str
    parameters: list[str]
    description: str


class ApiIndexOut(BaseModel):
    endpoints: list[ApiEndpointOut]


class AgentSummaryOut(BaseModel):
    schema_version: int
    id: str
    mtime: float
    agents: list[AgentSummaryRowOut]


def node_out(
    node: Node,
    agent_ids: dict[str, int] | None = None,
    owning_agent_id: int = 1,
    max_depth: int | None = None,
    activity: Mapping[int, NodeActivity] | None = None,
) -> NodeOut:
    """The node and its subtree, without prompt, result and tool-argument texts.

    `activity` is the precomputed activity of the complete tree; it defaults to `node_activity(node)`, so a bounded
    projection keeps the activity of the descendants it omits.
    """
    activity = node_activity(node) if activity is None else activity
    agent_ids = agent_ids or {}
    agent_id = (
        agent_ids.get(node.agent_uuid or node.node_id, owning_agent_id)
        if node.kind is NodeKind.AGENT
        else owning_agent_id
    )
    children = (
        [
            node_out(
                child,
                agent_ids,
                agent_id,
                None if max_depth is None else max_depth - 1,
                activity,
            )
            for child in node.children
        ]
        if max_depth != 0
        else []
    )
    flags = activity[id(node)]
    return NodeOut(
        node_id=node.node_id,
        agent_id=agent_id,
        harness_agent_id=node.agent_uuid if node.kind is NodeKind.AGENT else None,
        active=flags.active,
        active_descendant=flags.active_descendant,
        activity=flags.activity,
        kind=node.kind.value,
        topic=node.topic,
        model=node.model,
        success=node.success,
        tool=node.tool,
        start=node.start,
        end=node.end,
        duration=node.duration,
        user_wait=node.user_wait,
        llm_call_count=node.llm_call_count,
        tool_call_count=node.tool_call_count,
        tokens=node.tokens,
        tokens_total=node.tokens_total,
        cost_total=node.cost_total,
        cost_own=node.cost_own,
        context_peak=node.context_peak,
        compactions=node.compactions,
        resume_times=node.resume_times,
        llm_calls=node.llm_calls,
        execution_events=node.execution_events,
        findings=node.findings,
        children=children,
    )


def _agent_rows(session: Session) -> list[AgentSummaryRowOut]:
    return [AgentSummaryRowOut.model_validate(group) for group in agent_groups(session.root)]


def session_out(session: Session, mtime: float) -> SessionOut:
    return SessionOut(
        id=session.id,
        agent=session.agent,
        title=session.title,
        workspace=session.workspace,
        mtime=mtime,
        sources=session.sources,
        diagnostics=session.diagnostics,
        agents=_agent_rows(session),
        root=node_out(session.root, agent_ids(session.root)),
    )


def agent_summary_out(session: Session, mtime: float) -> AgentSummaryOut:
    return AgentSummaryOut(
        schema_version=1,
        id=session.id,
        mtime=mtime,
        agents=_agent_rows(session),
    )


def node_detail_out(node: Node) -> NodeDetailOut:
    return NodeDetailOut(
        node_id=node.node_id,
        prompt=node.prompt,
        result=node.result,
        arguments=node.tool.arguments if node.tool is not None else {},
    )


def summary_out(row: SessionRow) -> SummaryOut:
    """A list row: the native id as title until summarised, the summary (possibly outdated) afterwards."""
    summary = row.summary
    state = row.state
    return SummaryOut(
        id=row.ref.id,
        agent=row.ref.agent,
        title=summary.title if summary is not None else row.ref.native_id,
        workspace=summary.workspace if summary is not None else None,
        state=state.value,
        mtime=row.ref.mtime,
        start_ms=summary.start_ms if summary is not None else None,
        last_activity_ms=summary.last_activity_ms if summary is not None else None,
        end_ms=summary.end_ms if summary is not None else None,
        file_size=summary.file_size if summary is not None else None,
        cost_total=summary.cost_total if summary is not None else None,
        error=row.error if state is RowState.ERROR else None,
    )


_SESSION_FIELDS = ("session", "diagnostics", "tree")


def _mark_omitted(node: dict[str, Any], source: Node, depth: int) -> None:
    """Mark omitted descendants on a tree already mapped only to `depth`."""
    node["children_omitted"] = bool(source.children) if depth == 0 else False
    if depth > 0:
        for mapped, child in zip(node["children"], source.children, strict=True):
            _mark_omitted(mapped, child, depth - 1)


def projected_session_out(session: Session, mtime: float, depth: int | None, fields: str | None) -> dict[str, Any]:
    """Select documented top-level groups and optionally bound tree depth; `ValueError` on unknown `fields`."""
    selected = _SESSION_FIELDS if fields is None else tuple(part.strip() for part in fields.split(","))
    if not selected or any(part not in _SESSION_FIELDS for part in selected):
        raise ValueError("fields must contain: session, diagnostics, tree")
    projected: dict[str, Any] = {}
    if "session" in selected:
        projected.update(
            id=session.id,
            agent=session.agent,
            title=session.title,
            workspace=session.workspace,
            mtime=mtime,
            sources=session.sources,
        )
    if "diagnostics" in selected:
        projected["diagnostics"] = DiagnosticsOut.model_validate(session.diagnostics).model_dump(mode="json")
    if "tree" in selected:
        root = node_out(
            session.root,
            agent_ids(session.root),
            max_depth=depth,
        ).model_dump(mode="json")
        if depth is not None:
            _mark_omitted(root, session.root, depth)
        projected["root"] = root
    return projected
