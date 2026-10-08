# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Generic roll-ups over a neutral tree: tokens, time spans, cost, tool call counts and context.

Adapters set only what they know; these rules fill in the rest the same way for every agent.
"""

from collections.abc import Callable
from itertools import pairwise

from agentprof.model import (
    CostMetric,
    LlmCall,
    Metric,
    Node,
    NodeKind,
    Provenance,
    Tokens,
    context_size,
    sum_costs,
    worst_provenance,
)

# Node kinds that own LLM calls and therefore tokens and cost; tool nodes and the session root never do.
_WORKER_KINDS = (NodeKind.TURN, NodeKind.AGENT)


def _sum_metrics(metrics: list[Metric]) -> Metric:
    available = [metric for metric in metrics if metric.value is not None]
    if not available:
        return Metric.not_available()
    provenance = worst_provenance(*(metric.provenance for metric in available))
    if len(available) < len(metrics):
        provenance = worst_provenance(provenance, Provenance.ESTIMATED)
    return Metric(value=sum(metric.number() for metric in available), provenance=provenance)


def sum_tokens(tokens: list[Tokens]) -> Tokens:
    """Add token counts field by field."""
    return Tokens(
        input=_sum_metrics([t.input for t in tokens]),
        output=_sum_metrics([t.output for t in tokens]),
        cache_read=_sum_metrics([t.cache_read for t in tokens]),
        cache_write=_sum_metrics([t.cache_write for t in tokens]),
        cache_write_5m=_sum_metrics([t.cache_write_5m for t in tokens]),
        cache_write_1h=_sum_metrics([t.cache_write_1h for t in tokens]),
    )


def _call_end(call: LlmCall) -> Metric:
    if call.start.value is None:
        return Metric.not_available()
    if call.duration.value is None:
        return Metric(value=call.start.value, provenance=worst_provenance(call.start.provenance, Provenance.ESTIMATED))
    return Metric(
        value=call.start.number() + call.duration.number(),
        provenance=worst_provenance(call.start.provenance, call.duration.provenance),
    )


def _extreme(metrics: list[Metric], pick: Callable[..., Metric]) -> Metric:
    available = [metric for metric in metrics if metric.value is not None]
    if not available:
        return Metric.not_available()
    chosen = pick(available, key=Metric.number)
    if len(available) < len(metrics):
        return Metric(value=chosen.value, provenance=worst_provenance(chosen.provenance, Provenance.ESTIMATED))
    return chosen


def _roll_up_span(node: Node) -> None:
    if node.start.value is None:
        node.start = _extreme([c.start for c in node.children] + [call.start for call in node.llm_calls], min)
    if node.end.value is None:
        derived_end = _extreme([c.end for c in node.children] + [_call_end(call) for call in node.llm_calls], max)
        node.end = Metric.estimated(derived_end.number()) if derived_end.value is not None else Metric.not_available()
    if node.duration.value is None and node.start.value is not None and node.end.value is not None:
        node.duration = Metric(
            value=node.end.number() - node.start.number(),
            provenance=worst_provenance(node.start.provenance, node.end.provenance),
        )


def _roll_up_tokens(node: Node) -> None:
    if node.llm_calls:
        node.tokens = sum_tokens([call.tokens for call in node.llm_calls])
    parts = [child.tokens_total for child in node.children if child.kind in _WORKER_KINDS]
    if node.kind in _WORKER_KINDS:
        parts.append(node.tokens)
    if parts:
        node.tokens_total = sum_tokens(parts)


def _subtract_children(node: Node) -> None:
    """`cost_own` = known `cost_total` minus the direct agent children's totals of the same unit."""
    total = node.cost_total
    if total.value is None:
        return
    agent_costs = [child.cost_total for child in node.children if child.kind is NodeKind.AGENT]
    subtractable = [value for cost in agent_costs if cost.unit == total.unit and (value := cost.value) is not None]
    own = total.value - sum(subtractable)
    if own < 0:
        return  # children report more than the total (seen in real Copilot data): own cost is unknowable
    exact = len(subtractable) == len(agent_costs) and total.provenance is Provenance.EXACT
    node.cost_own = CostMetric(
        value=own,
        unit=total.unit,
        provenance=Provenance.EXACT if exact else Provenance.ESTIMATED,
        usd_per_unit=total.usd_per_unit,
    )


def _roll_up_cost(node: Node) -> None:
    if node.cost_own.value is None and node.llm_calls:
        node.cost_own = sum_costs([call.cost for call in node.llm_calls])
    if node.cost_total.value is not None:
        if node.cost_own.value is None:
            _subtract_children(node)
        return
    parts = [child.cost_total for child in node.children if child.kind in _WORKER_KINDS]
    if node.llm_calls:
        parts.append(node.cost_own)
    if parts:
        node.cost_total = sum_costs(parts)


# A call whose context is smaller than this share of the previous call's marks a compaction.
_COMPACTION_DROP = 0.5


def _sized_calls(calls: list[LlmCall]) -> list[tuple[LlmCall, Metric]]:
    """Calls in the agent's context with a start and a known context size, in time order."""
    sized: list[tuple[LlmCall, Metric]] = []
    for call in calls:
        size = context_size(call.tokens)
        if call.in_context and call.start.value is not None and size.value is not None:
            sized.append((call, size))
    return sorted(sized, key=lambda item: item[0].start.number())


def _drops(sized: list[tuple[LlmCall, Metric]]) -> list[LlmCall]:
    """Calls whose context is below `_COMPACTION_DROP` of the previous call's: the first call after a compaction."""
    return [
        later for (_, before), (later, after) in pairwise(sized) if after.number() < before.number() * _COMPACTION_DROP
    ]


def _roll_up_main_agent_context(session: Node) -> None:
    """The main agent's context runs through all turns, so a compaction may take effect at a turn boundary.

    The session node reports the whole context: the largest peak and every compaction of its turns.
    Its calls stay on the turns, so tokens and cost are not counted twice.
    """
    turns = [child for child in session.children if child.kind is NodeKind.TURN]
    owners = {id(call): turn for turn in turns for call in turn.llm_calls}
    recorded = {id(turn) for turn in turns if turn.compactions}
    for later in _drops(_sized_calls([call for turn in turns for call in turn.llm_calls])):
        turn = owners[id(later)]
        if id(turn) not in recorded:
            turn.compactions.append(Metric.estimated(later.start.number()))
    peaks = [turn.context_peak for turn in turns if turn.context_peak.value is not None]
    if peaks:
        session.context_peak = max(peaks, key=Metric.number)
    session.compactions = sorted(
        (compaction for turn in turns for compaction in turn.compactions if compaction.value is not None),
        key=Metric.number,
    )


def _roll_up_context(node: Node) -> None:
    """Context peak over a node's own calls; compactions detected unless the adapter recorded them.

    Sub-agents own their whole context; the main agent's context spans all turns and is checked on the session.
    """
    if node.kind is NodeKind.SESSION:
        _roll_up_main_agent_context(node)
        return
    if node.kind not in _WORKER_KINDS:
        return
    sized = _sized_calls(node.llm_calls)
    if not sized:
        return
    node.context_peak = max((size for _, size in sized), key=Metric.number)
    if node.kind is NodeKind.AGENT and not node.compactions:
        node.compactions = [Metric.estimated(later.start.number()) for later in _drops(sized)]


def roll_up(node: Node) -> None:
    """Fill derived metrics bottom-up, following the design spec's "Roll-ups" section."""
    for child in node.children:
        roll_up(child)
    node.tool_call_count = Metric.exact(len(node.children))
    _roll_up_tokens(node)
    _roll_up_span(node)
    _roll_up_cost(node)
    _roll_up_context(node)
