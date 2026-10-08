# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Agent-neutral data model shared by all adapters, the analysis layer and the server."""

from collections.abc import Iterator
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal


class Provenance(StrEnum):
    """How trustworthy a metric's value is."""

    EXACT = "exact"
    ESTIMATED = "estimated"
    NOT_AVAILABLE = "n/a"


_PROVENANCE_RANK = {Provenance.EXACT: 0, Provenance.ESTIMATED: 1, Provenance.NOT_AVAILABLE: 2}


def worst_provenance(*provenances: Provenance) -> Provenance:
    """Return the least trustworthy of `provenances`; `EXACT` if none are given."""
    return max(provenances, key=_PROVENANCE_RANK.__getitem__, default=Provenance.EXACT)


@dataclass(frozen=True)
class Metric:
    """A numeric measurement with a provenance tag. `value` is `None` exactly when not available."""

    value: float | int | None
    provenance: Provenance

    @staticmethod
    def not_available() -> "Metric":
        return Metric(value=None, provenance=Provenance.NOT_AVAILABLE)

    @staticmethod
    def exact(value: float | int) -> "Metric":
        return Metric(value=value, provenance=Provenance.EXACT)

    @staticmethod
    def estimated(value: float | int) -> "Metric":
        return Metric(value=value, provenance=Provenance.ESTIMATED)

    def number(self) -> float:
        """Return the value as `float`; raises `ValueError` if the metric is not available."""
        if self.value is None:
            raise ValueError("metric is not available")
        return float(self.value)


@dataclass(frozen=True)
class CostMetric:
    """A cost in the agent's native unit (e.g. `credits`, `USD`); `usd_per_unit` converts other units to USD."""

    value: float | None
    unit: str | None
    provenance: Provenance
    usd_per_unit: float | None = None

    @property
    def usd(self) -> float | None:
        """The cost in USD, or `None` if it is not available or its unit has no known conversion."""
        if self.value is None:
            return None
        if self.unit == "USD":
            return self.value
        return self.value * self.usd_per_unit if self.usd_per_unit is not None else None

    @staticmethod
    def not_available() -> "CostMetric":
        return CostMetric(value=None, unit=None, provenance=Provenance.NOT_AVAILABLE)


def sum_costs(costs: list[CostMetric]) -> CostMetric:
    """Add costs of one unit; `estimated` if some are missing, `n/a` if none is available or units differ."""
    available = [cost for cost in costs if cost.value is not None]
    if not available:
        return CostMetric.not_available()
    units = {cost.unit for cost in available}
    if len(units) != 1:
        return CostMetric.not_available()
    provenance = worst_provenance(*(cost.provenance for cost in available))
    if len(available) < len(costs):
        provenance = worst_provenance(provenance, Provenance.ESTIMATED)
    total = sum(value for cost in available if (value := cost.value) is not None)
    rates = {cost.usd_per_unit for cost in available}
    return CostMetric(
        value=total,
        unit=units.pop(),
        provenance=provenance,
        usd_per_unit=rates.pop() if len(rates) == 1 else None,
    )


@dataclass
class Tokens:
    """Token counts; the four counts are disjoint (`input` excludes cached tokens)."""

    input: Metric = field(default_factory=Metric.not_available)
    output: Metric = field(default_factory=Metric.not_available)
    cache_read: Metric = field(default_factory=Metric.not_available)
    cache_write: Metric = field(default_factory=Metric.not_available)
    cache_write_5m: Metric = field(default_factory=Metric.not_available)
    cache_write_1h: Metric = field(default_factory=Metric.not_available)


@dataclass
class EventCallLink:
    """A link between an execution event and a model request."""

    source_request_id: str
    relation: Literal["requested_by", "consumed_by", "next_observed_call"]
    evidence: Literal["recorded", "observed_order"]
    owner_id: str | None = None


@dataclass
class ExecutionEvent:
    """An observed occurrence in an agent's execution history.

    `start` is the occurrence time, such as result receipt for a tool result.
    `execution_start` and `execution_end` retain the original invocation snapshot separately.
    """

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
    start: Metric = field(default_factory=Metric.not_available)
    source_order: int | None = None
    source_stream_id: str | None = None
    success: bool | None = None
    links: list[EventCallLink] = field(default_factory=list)
    execution_start: Metric = field(default_factory=Metric.not_available)
    execution_end: Metric = field(default_factory=Metric.not_available)


def context_size(tokens: Tokens) -> Metric:
    """Tokens sent to the model in one call: input, cache reads and cache writes; `n/a` if none of them is known."""
    parts = [metric for metric in (tokens.input, tokens.cache_read, tokens.cache_write) if metric.value is not None]
    if not parts:
        return Metric.not_available()
    return Metric(
        value=sum(metric.number() for metric in parts),
        provenance=worst_provenance(*(metric.provenance for metric in parts)),
    )


@dataclass
class LlmCall:
    """One request to a language model.

    `in_context` is false for side requests that do not belong to the agent's conversation (e.g. a background
    summary or a small helper model), so they do not count towards the agent's context size.
    """

    start: Metric
    duration: Metric = field(default_factory=Metric.not_available)
    model: str | None = None
    tokens: Tokens = field(default_factory=Tokens)
    cost: CostMetric = field(default_factory=CostMetric.not_available)
    in_context: bool = True
    call_id: str | None = None
    cost_parts: dict[str, CostMetric] = field(default_factory=dict)
    price_prefix: str | None = None
    gap: Metric = field(default_factory=Metric.not_available)
    gap_basis: str | None = None
    preceding_events: list["CallEvent"] = field(default_factory=list)
    cold_reason: str = "unknown"
    cold_rewrite: bool = False
    source_request_id: str | None = None
    source_order: int | None = None
    source_stream_id: str | None = None
    timing_basis: Literal["request_start", "assistant_message", "usage_report", "turn_start", "unknown"] = "unknown"


@dataclass(frozen=True)
class CallEvent:
    """A short reference to an event between two calls by the same agent."""

    kind: str
    event_id: str
    start: Metric
    end: Metric = field(default_factory=Metric.not_available)
    duration: Metric = field(default_factory=Metric.not_available)


class ToolCategory(StrEnum):
    """Agent-neutral tool classes; heuristics only ever look at these."""

    READ = "read"
    EDIT = "edit"
    SEARCH = "search"
    SHELL = "shell"
    SHELL_POLL = "shell_poll"
    WEB = "web"
    SUBAGENT = "subagent"
    OTHER = "other"


@dataclass
class ToolInfo:
    """A tool call's native identity, neutral category and normalised arguments.

    `writes_file` is true for tools that write a whole file (as opposed to editing part of one).
    `paths` lists every file the call touches, `path` is the first of them; it defaults to `path` alone.
    """

    native_id: str
    category: ToolCategory
    path: str | None = None
    line_range: tuple[int, int] | None = None
    command: str | None = None
    writes_file: bool = False
    arguments: dict[str, object] = field(default_factory=dict)
    paths: tuple[str, ...] = ()
    target_agent_id: str | None = None
    is_resume: bool = False
    linked_agent_node_id: str | None = None

    def __post_init__(self) -> None:
        if not self.paths and self.path is not None:
            self.paths = (self.path,)


class NodeKind(StrEnum):
    """The role of a node in the call tree."""

    SESSION = "session"
    TURN = "turn"
    AGENT = "agent"
    TOOL = "tool"


@dataclass
class Finding:
    """A waste heuristic hit, attached to a node."""

    heuristic_id: str
    node_id: str
    severity: str
    message: str
    evidence: dict[str, object] = field(default_factory=dict)
    estimated_avoidable_cost: CostMetric = field(default_factory=CostMetric.not_available)


@dataclass
class Node:
    """One entry in the call tree.

    `tokens` are the node's own LLM calls' tokens; `tokens_total` includes its subtree.
    `context_peak` is the largest context size of the node's own LLM calls; `compactions` are the times its own
    context was compacted.
    On the session node they cover the main agent's whole context, i.e. all turns.
    """

    node_id: str
    kind: NodeKind
    topic: str
    agent_uuid: str | None = None
    resume_times: list[Metric] = field(default_factory=list)
    model: str | None = None
    prompt: str = ""
    result: str = ""
    success: bool | None = None
    tool: ToolInfo | None = None
    children: list["Node"] = field(default_factory=list)
    start: Metric = field(default_factory=Metric.not_available)
    end: Metric = field(default_factory=Metric.not_available)
    duration: Metric = field(default_factory=Metric.not_available)
    user_wait: Metric = field(default_factory=Metric.not_available)
    llm_calls: list[LlmCall] = field(default_factory=list)
    llm_call_count: Metric = field(default_factory=Metric.not_available)
    tool_call_count: Metric = field(default_factory=Metric.not_available)
    tokens: Tokens = field(default_factory=Tokens)
    tokens_total: Tokens = field(default_factory=Tokens)
    cost_total: CostMetric = field(default_factory=CostMetric.not_available)
    cost_own: CostMetric = field(default_factory=CostMetric.not_available)
    findings: list[Finding] = field(default_factory=list)
    context_peak: Metric = field(default_factory=Metric.not_available)
    compactions: list[Metric] = field(default_factory=list)
    execution_events: list[ExecutionEvent] = field(default_factory=list)


def iter_nodes(root: Node) -> Iterator[Node]:
    """Yield `root` and all its descendants, depth first."""
    yield root
    for child in root.children:
        yield from iter_nodes(child)


@dataclass(frozen=True)
class MalformedLineDetail:
    """Location and redacted syntax of one skipped source line."""

    source_path: str
    line_number: int
    excerpt: str
    error_category: str


@dataclass
class Diagnostics:
    """Problems found while parsing a session."""

    malformed_lines: int = 0
    malformed_line_details: list[MalformedLineDetail] = field(default_factory=list)
    unknown_tool_ids: dict[str, int] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


@dataclass
class Session:
    """A fully parsed session. `id` is `<adapter>:<native-id>`."""

    id: str
    agent: str
    title: str
    workspace: str | None
    root: Node
    sources: list[str] = field(default_factory=list)
    diagnostics: Diagnostics = field(default_factory=Diagnostics)

    @property
    def start(self) -> Metric:
        return self.root.start

    @property
    def end(self) -> Metric:
        return self.root.end
