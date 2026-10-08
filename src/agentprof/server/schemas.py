# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""API response models and their mapping from the neutral model and registry rows."""

from typing import Any, Literal

from pydantic import BaseModel, Field

from agentprof.analysis.agent_summary import AgentGroup, agent_groups, agent_ids
from agentprof.model import (
    CallEvent,
    CostMetric,
    Diagnostics,
    EventCallLink,
    ExecutionEvent,
    Finding,
    LlmCall,
    Metric,
    Node,
    NodeKind,
    Provenance,
    Session,
    Tokens,
    ToolInfo,
)
from agentprof.registry import RowState, SessionRow

_ACTIVE_KINDS = (NodeKind.TURN, NodeKind.AGENT)


class MetricOut(BaseModel):
    value: float | None
    provenance: str


class CostOut(BaseModel):
    value: float | None
    unit: str | None
    usd: float | None
    provenance: str


class TokensOut(BaseModel):
    input: MetricOut
    output: MetricOut
    cache_read: MetricOut
    cache_write: MetricOut
    cache_write_5m: MetricOut
    cache_write_1h: MetricOut


class ToolOut(BaseModel):
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


class LlmCallOut(BaseModel):
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
    timing_basis: Literal["request_start", "assistant_message", "usage_report", "turn_start", "unknown"] = "unknown"


class CallEventOut(BaseModel):
    kind: str
    event_id: str
    start: MetricOut
    end: MetricOut
    duration: MetricOut


class EventCallLinkOut(BaseModel):
    source_request_id: str
    relation: Literal["requested_by", "consumed_by", "next_observed_call"]
    evidence: Literal["recorded", "observed_order"]
    owner_id: str | None = None


class ExecutionEventOut(BaseModel):
    kind: Literal[
        "user_input",
        "tool_start",
        "tool_result",
        "delegation",
        "child_completion",
        "completion",
        "message",
        "resume",
        "compaction",
    ]
    event_id: str | None = None
    subject_node_id: str | None = None
    start: MetricOut
    source_order: int | None = None
    source_stream_id: str | None = None
    success: bool | None = None
    links: list[EventCallLinkOut]
    execution_start: MetricOut
    execution_end: MetricOut


class FindingOut(BaseModel):
    heuristic_id: str
    node_id: str
    severity: str
    message: str
    evidence: dict[str, Any]
    estimated_avoidable_cost: CostOut


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


class DiagnosticsOut(BaseModel):
    malformed_lines: int
    unknown_tool_ids: dict[str, int]
    warnings: list[str]


class MalformedLineDetailOut(BaseModel):
    source_path: str
    line_number: int
    excerpt: str
    error_category: str


class DiagnosticsDetailOut(DiagnosticsOut):
    malformed_line_details: list[MalformedLineDetailOut]


class SessionOut(BaseModel):
    id: str
    agent: str
    title: str
    workspace: str | None
    mtime: float
    sources: list[str]
    diagnostics: DiagnosticsOut
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


class AgentSummaryRowOut(BaseModel):
    agent_id: int
    harness_agent_id: str | None
    parent_agent_id: int | None
    topic: str
    models: list[str]
    llm_calls: MetricOut
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


class AgentSummaryOut(BaseModel):
    schema_version: int
    id: str
    mtime: float
    agents: list[AgentSummaryRowOut]


def metric_out(metric: Metric) -> MetricOut:
    return MetricOut(value=metric.value, provenance=metric.provenance.value)


def cost_out(cost: CostMetric) -> CostOut:
    return CostOut(value=cost.value, unit=cost.unit, usd=cost.usd, provenance=cost.provenance.value)


def tokens_out(tokens: Tokens) -> TokensOut:
    return TokensOut(
        input=metric_out(tokens.input),
        output=metric_out(tokens.output),
        cache_read=metric_out(tokens.cache_read),
        cache_write=metric_out(tokens.cache_write),
        cache_write_5m=metric_out(tokens.cache_write_5m),
        cache_write_1h=metric_out(tokens.cache_write_1h),
    )


def _tool_out(tool: ToolInfo) -> ToolOut:
    return ToolOut(
        native_id=tool.native_id,
        category=tool.category.value,
        path=tool.path,
        paths=list(tool.paths),
        line_range=tool.line_range,
        command=tool.command,
        writes_file=tool.writes_file,
        target_agent_id=tool.target_agent_id,
        is_resume=tool.is_resume,
        linked_agent_node_id=tool.linked_agent_node_id,
    )


def _llm_call_out(call: LlmCall) -> LlmCallOut:
    return LlmCallOut(
        call_id=call.call_id,
        start=metric_out(call.start),
        duration=metric_out(call.duration),
        model=call.model,
        tokens=tokens_out(call.tokens),
        cost=cost_out(call.cost),
        in_context=call.in_context,
        cost_parts={kind: cost_out(part) for kind, part in call.cost_parts.items()},
        price_prefix=call.price_prefix,
        gap=metric_out(call.gap),
        gap_basis=call.gap_basis,
        preceding_events=[_call_event_out(event) for event in call.preceding_events],
        cold_reason=call.cold_reason,
        cold_rewrite=call.cold_rewrite,
        source_request_id=call.source_request_id,
        source_order=call.source_order,
        source_stream_id=call.source_stream_id,
        timing_basis=call.timing_basis,
    )


def _event_call_link_out(link: EventCallLink) -> EventCallLinkOut:
    return EventCallLinkOut(
        source_request_id=link.source_request_id,
        relation=link.relation,
        evidence=link.evidence,
        owner_id=link.owner_id,
    )


def _execution_event_out(event: ExecutionEvent) -> ExecutionEventOut:
    return ExecutionEventOut(
        kind=event.kind,
        event_id=event.event_id,
        subject_node_id=event.subject_node_id,
        start=metric_out(event.start),
        source_order=event.source_order,
        source_stream_id=event.source_stream_id,
        success=event.success,
        links=[_event_call_link_out(link) for link in event.links],
        execution_start=metric_out(event.execution_start),
        execution_end=metric_out(event.execution_end),
    )


def _call_event_out(event: CallEvent) -> CallEventOut:
    return CallEventOut(
        kind=event.kind,
        event_id=event.event_id,
        start=metric_out(event.start),
        end=metric_out(event.end),
        duration=metric_out(event.duration),
    )


def finding_out(finding: Finding) -> FindingOut:
    return FindingOut(
        heuristic_id=finding.heuristic_id,
        node_id=finding.node_id,
        severity=finding.severity,
        message=finding.message,
        evidence=finding.evidence,
        estimated_avoidable_cost=cost_out(finding.estimated_avoidable_cost),
    )


def activity_flags(root: Node, frontier: float | None) -> dict[int, tuple[bool, bool]]:
    """Compute activity over the complete neutral tree for bounded projections."""
    flags: dict[int, tuple[bool, bool]] = {}

    def visit(node: Node) -> bool:
        descendant = any([visit(child) for child in node.children])
        active = (
            node.kind is not NodeKind.SESSION
            and node.start.value is not None
            and node.end.provenance is not Provenance.EXACT
            and (frontier is None or node.end.value is None or node.end.number() >= frontier)
        )
        flags[id(node)] = (active, descendant)
        return (node.kind in _ACTIVE_KINDS and active) or descendant

    visit(root)
    return flags


def node_out(
    node: Node,
    agent_ids: dict[str, int] | None = None,
    owning_agent_id: int = 1,
    frontier: float | None = None,
    max_depth: int | None = None,
    activity_flags: dict[int, tuple[bool, bool]] | None = None,
) -> NodeOut:
    """The node and its subtree, without prompt, result and tool-argument texts.

    `frontier` is the session's latest known timestamp (the root's rolled-up end); a node whose own end falls
    short of it has already been overtaken by later activity elsewhere and is therefore not active, even when
    that end is not `EXACT` (e.g. an adapter that never recorded one for a completed node).
    """
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
                frontier,
                None if max_depth is None else max_depth - 1,
                activity_flags,
            )
            for child in node.children
        ]
        if max_depth != 0
        else []
    )
    active = (
        node.kind is not NodeKind.SESSION
        and node.start.value is not None
        and node.end.provenance is not Provenance.EXACT
        and (frontier is None or node.end.value is None or node.end.number() >= frontier)
    )
    # A tool node is never itself an activity indicator, but a sub-agent nested under one still counts.
    active_descendant = any(
        (child.kind in _ACTIVE_KINDS and child.active) or child.active_descendant for child in children
    )
    if activity_flags is not None:
        active, active_descendant = activity_flags[id(node)]
    activity = (
        "waiting"
        if node.kind in _ACTIVE_KINDS and active_descendant
        else "running"
        if node.kind in _ACTIVE_KINDS and active
        else None
    )
    return NodeOut(
        node_id=node.node_id,
        agent_id=agent_id,
        harness_agent_id=node.agent_uuid if node.kind is NodeKind.AGENT else None,
        active=active,
        active_descendant=active_descendant,
        activity=activity,
        kind=node.kind.value,
        topic=node.topic,
        model=node.model,
        success=node.success,
        tool=_tool_out(node.tool) if node.tool is not None else None,
        start=metric_out(node.start),
        end=metric_out(node.end),
        duration=metric_out(node.duration),
        user_wait=metric_out(node.user_wait),
        llm_call_count=metric_out(node.llm_call_count),
        tool_call_count=metric_out(node.tool_call_count),
        tokens=tokens_out(node.tokens),
        tokens_total=tokens_out(node.tokens_total),
        cost_total=cost_out(node.cost_total),
        cost_own=cost_out(node.cost_own),
        context_peak=metric_out(node.context_peak),
        compactions=[metric_out(compaction) for compaction in node.compactions],
        resume_times=[metric_out(point) for point in node.resume_times],
        llm_calls=[_llm_call_out(call) for call in node.llm_calls],
        execution_events=[_execution_event_out(event) for event in node.execution_events],
        findings=[finding_out(finding) for finding in node.findings],
        children=children,
    )


def diagnostics_out(diagnostics: Diagnostics) -> DiagnosticsOut:
    return DiagnosticsOut(
        malformed_lines=diagnostics.malformed_lines,
        unknown_tool_ids=diagnostics.unknown_tool_ids,
        warnings=diagnostics.warnings,
    )


def diagnostics_detail_out(diagnostics: Diagnostics) -> DiagnosticsDetailOut:
    """Map diagnostic counts and bounded source-line details for the dedicated endpoint."""
    return DiagnosticsDetailOut(
        malformed_lines=diagnostics.malformed_lines,
        unknown_tool_ids=diagnostics.unknown_tool_ids,
        warnings=diagnostics.warnings,
        malformed_line_details=[
            MalformedLineDetailOut(
                source_path=detail.source_path,
                line_number=detail.line_number,
                excerpt=detail.excerpt,
                error_category=detail.error_category,
            )
            for detail in diagnostics.malformed_line_details
        ],
    )


def session_out(session: Session, mtime: float) -> SessionOut:
    return SessionOut(
        id=session.id,
        agent=session.agent,
        title=session.title,
        workspace=session.workspace,
        mtime=mtime,
        sources=session.sources,
        diagnostics=diagnostics_out(session.diagnostics),
        root=node_out(session.root, agent_ids(session.root), frontier=session.root.end.value),
    )


def agent_summary_row_out(group: AgentGroup) -> AgentSummaryRowOut:
    return AgentSummaryRowOut(
        agent_id=group.agent_id,
        harness_agent_id=group.harness_agent_id,
        parent_agent_id=group.parent_agent_id,
        topic=group.topic,
        models=group.models,
        llm_calls=metric_out(group.llm_calls),
        context_peak=metric_out(group.context_peak),
        tokens=tokens_out(group.tokens),
        own_cost=cost_out(group.own_cost),
        subtree_cost=cost_out(group.subtree_cost),
        start=metric_out(group.start),
        end=metric_out(group.end),
        cost_parts={kind: cost_out(part) for kind, part in group.cost_parts.items()},
        cache_ttl=group.cache_ttl,
        cold_rewrites=metric_out(group.cold_rewrites),
        cold_rewrite_cost=cost_out(group.cold_rewrite_cost),
        longest_gap=metric_out(group.longest_gap),
        findings_count=group.findings_count,
        resume_count=group.resume_count,
    )


def agent_summary_out(session: Session, mtime: float) -> AgentSummaryOut:
    return AgentSummaryOut(
        schema_version=1,
        id=session.id,
        mtime=mtime,
        agents=[agent_summary_row_out(group) for group in agent_groups(session.root)],
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
        cost_total=cost_out(summary.cost_total) if summary is not None else None,
        error=row.error if state is RowState.ERROR else None,
    )
