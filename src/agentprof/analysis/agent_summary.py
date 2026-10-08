"""Aggregate a session by owning agent without adding descendant cost to own cost."""

from dataclasses import dataclass

from agentprof.analysis.rollup import sum_tokens
from agentprof.model import CostMetric, Metric, Node, NodeKind, Provenance, Tokens, sum_costs, worst_provenance


@dataclass(frozen=True)
class AgentGroup:
    agent_id: int
    harness_agent_id: str | None
    parent_agent_id: int | None
    topic: str
    models: list[str]
    llm_calls: Metric
    context_peak: Metric
    tokens: Tokens
    own_cost: CostMetric
    subtree_cost: CostMetric
    start: Metric
    end: Metric
    cost_parts: dict[str, CostMetric]
    cache_ttl: str
    cold_rewrites: Metric
    cold_rewrite_cost: CostMetric
    longest_gap: Metric
    findings_count: int
    resume_count: int


def agent_ids(root: Node) -> dict[str, int]:
    """Assign chronological display IDs to distinct subagent identities."""
    agents: list[Node] = []

    def visit(node: Node) -> None:
        if node.kind is NodeKind.AGENT:
            agents.append(node)
        for child in node.children:
            visit(child)

    visit(root)
    if all(node.start.value is not None for node in agents):
        agents.sort(key=lambda node: node.start.number())
    identities = dict.fromkeys(node.agent_uuid or node.node_id for node in agents)
    return {identity: index for index, identity in enumerate(identities, start=2)}


def _sum_metrics(metrics: list[Metric]) -> Metric:
    available = [metric for metric in metrics if metric.value is not None]
    if not available:
        return Metric.not_available()
    provenance = worst_provenance(*(metric.provenance for metric in available))
    if len(available) != len(metrics):
        provenance = worst_provenance(provenance, Provenance.ESTIMATED)
    return Metric(value=sum(metric.number() for metric in available), provenance=provenance)


def _extreme(metrics: list[Metric], greatest: bool) -> Metric:
    available = [metric for metric in metrics if metric.value is not None]
    if not available:
        return Metric.not_available()
    chosen = (max if greatest else min)(available, key=Metric.number)
    provenance = chosen.provenance
    if len(available) != len(metrics):
        provenance = worst_provenance(provenance, Provenance.ESTIMATED)
    return Metric(value=chosen.value, provenance=provenance)


def agent_groups(root: Node) -> list[AgentGroup]:
    """Return one row for the main agent and each distinct subagent identity."""
    ids = agent_ids(root)
    owned: dict[int, list[Node]] = {1: []}
    tops: dict[int, list[Node]] = {1: [root]}
    parents: dict[int, set[int]] = {1: set()}
    finding_counts: dict[int, int] = {1: 0}

    def visit(node: Node, owner: int) -> None:
        if node.kind is NodeKind.AGENT:
            agent_id = ids[node.agent_uuid or node.node_id]
            if agent_id != owner:
                parents.setdefault(agent_id, set()).add(owner)
                tops.setdefault(agent_id, []).append(node)
            owner = agent_id
        if node.kind in (NodeKind.TURN, NodeKind.AGENT):
            owned.setdefault(owner, []).append(node)
        finding_counts[owner] = finding_counts.get(owner, 0) + len(node.findings)
        for child in node.children:
            visit(child, owner)

    visit(root, 1)
    groups: list[AgentGroup] = []
    for agent_id, nodes in sorted(owned.items()):
        representative = root if agent_id == 1 else next(node for node in nodes if node.kind is NodeKind.AGENT)
        observed = {
            call.model for node in nodes for call in node.llm_calls if call.model and not call.model.startswith("<")
        }
        models = sorted(observed or {node.model for node in nodes if node.model is not None})
        counts = [
            node.llm_call_count
            if node.llm_call_count.value is not None or not node.llm_calls
            else Metric.exact(len(node.llm_calls))
            for node in nodes
        ]
        parent_ids = parents.get(agent_id, set())
        calls = [call for node in nodes for call in node.llm_calls]
        cost_kinds = ("input", "output", "cache_read", "cache_write_5m", "cache_write_1h")
        cost_parts = {
            kind: sum_costs([call.cost_parts.get(kind, CostMetric.not_available()) for call in calls])
            for kind in cost_kinds
        }
        writes = [
            call for call in calls if call.tokens.cache_write.value is not None and call.tokens.cache_write.number() > 0
        ]
        known_ttls = [
            call
            for call in writes
            if call.tokens.cache_write_5m.value is not None and call.tokens.cache_write_1h.value is not None
        ]
        if not writes or len(known_ttls) != len(writes):
            cache_ttl = "unknown"
        else:
            five = any(call.tokens.cache_write_5m.number() > 0 for call in known_ttls)
            one = any(call.tokens.cache_write_1h.number() > 0 for call in known_ttls)
            cache_ttl = "mixed" if five and one else "5m" if five else "1h"
        cold_calls = [call for call in calls if call.cold_rewrite]
        cold_costs = [
            sum_costs(
                [
                    call.cost_parts.get("cache_write_5m", CostMetric.not_available()),
                    call.cost_parts.get("cache_write_1h", CostMetric.not_available()),
                ]
            )
            for call in cold_calls
        ]
        groups.append(
            AgentGroup(
                agent_id=agent_id,
                harness_agent_id=representative.agent_uuid if agent_id != 1 else None,
                parent_agent_id=next(iter(parent_ids)) if len(parent_ids) == 1 else None,
                topic=representative.topic,
                models=models,
                llm_calls=_sum_metrics(counts),
                context_peak=(
                    root.context_peak if agent_id == 1 else _extreme([node.context_peak for node in nodes], True)
                ),
                tokens=sum_tokens([node.tokens for node in nodes]),
                own_cost=sum_costs([node.cost_own for node in nodes]),
                subtree_cost=sum_costs([node.cost_total for node in tops[agent_id]]),
                start=_extreme([node.start for node in nodes], False),
                end=_extreme([node.end for node in nodes], True),
                cost_parts=cost_parts,
                cache_ttl=cache_ttl,
                cold_rewrites=Metric.exact(len(cold_calls)),
                cold_rewrite_cost=sum_costs(cold_costs),
                longest_gap=_extreme([call.gap for call in calls], True),
                findings_count=finding_counts.get(agent_id, 0),
                resume_count=sum(len(node.resume_times) for node in nodes),
            )
        )
    return groups
