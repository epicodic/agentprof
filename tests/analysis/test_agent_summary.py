from agentprof.analysis.agent_summary import agent_groups
from agentprof.model import CostMetric, Finding, LlmCall, Metric, Node, NodeKind, Provenance, Tokens


def _cost(value: float) -> CostMetric:
    return CostMetric(value=value, unit="USD", provenance=Provenance.ESTIMATED)


def test_agent_groups_keep_main_turns_and_nested_agents_separate() -> None:
    worker = Node(
        node_id="worker",
        kind=NodeKind.AGENT,
        topic="Worker",
        agent_uuid="worker-id",
        start=Metric.exact(30),
        end=Metric.exact(50),
        cost_own=_cost(2),
        cost_total=_cost(2),
        llm_calls=[LlmCall(start=Metric.exact(30), model="full-worker-model")],
        tokens=Tokens(input=Metric.exact(20)),
        context_peak=Metric.exact(20),
    )
    lead = Node(
        node_id="lead",
        kind=NodeKind.AGENT,
        topic="Lead",
        agent_uuid="lead-id",
        start=Metric.exact(20),
        end=Metric.exact(60),
        cost_own=_cost(3),
        cost_total=_cost(5),
        llm_calls=[LlmCall(start=Metric.exact(20), model="full-lead-model")],
        tokens=Tokens(input=Metric.exact(30)),
        context_peak=Metric.exact(30),
        children=[worker],
    )
    first = Node(
        node_id="turn-1",
        kind=NodeKind.TURN,
        topic="First",
        start=Metric.exact(1),
        end=Metric.exact(70),
        cost_own=_cost(7),
        tokens=Tokens(input=Metric.exact(70)),
        llm_calls=[LlmCall(start=Metric.exact(1), model="main-model")],
        children=[lead],
    )
    second = Node(
        node_id="turn-2",
        kind=NodeKind.TURN,
        topic="Second",
        start=Metric.exact(80),
        end=Metric.exact(90),
        cost_own=_cost(1),
        tokens=Tokens(input=Metric.exact(10)),
        llm_calls=[LlmCall(start=Metric.exact(80), model="main-model")],
    )
    root = Node(
        node_id="session",
        kind=NodeKind.SESSION,
        topic="Story",
        children=[first, second],
        start=Metric.exact(1),
        end=Metric.exact(90),
        cost_total=_cost(13),
        context_peak=Metric.exact(70),
    )

    main, lead_group, worker_group = agent_groups(root)

    assert [group.agent_id for group in (main, lead_group, worker_group)] == [1, 2, 3]
    assert [group.parent_agent_id for group in (main, lead_group, worker_group)] == [None, 1, 2]
    assert [group.own_cost.value for group in (main, lead_group, worker_group)] == [8, 3, 2]
    assert [group.subtree_cost.value for group in (main, lead_group, worker_group)] == [13, 5, 2]
    assert main.llm_calls.value == 2
    assert lead_group.harness_agent_id == "lead-id"
    assert lead_group.models == ["full-lead-model"]


def test_agent_groups_preserve_unavailable_values() -> None:
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="Empty")

    (main,) = agent_groups(root)

    assert main.own_cost.value is None
    assert main.tokens.input.value is None
    assert main.llm_calls.value is None


def test_agent_summary_breaks_down_cost_and_counts_measured_rewrites() -> None:
    call = LlmCall(
        start=Metric.exact(100),
        tokens=Tokens(
            cache_write=Metric.exact(60_000),
            cache_write_5m=Metric.exact(60_000),
            cache_write_1h=Metric.exact(0),
        ),
        cost_parts={"input": _cost(1), "cache_write_5m": _cost(2)},
        cold_rewrite=True,
    )
    turn = Node(node_id="turn", kind=NodeKind.TURN, topic="t", llm_calls=[call], cost_own=_cost(3))
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[turn], cost_total=_cost(3))

    (main,) = agent_groups(root)

    assert main.cost_parts["input"].value == 1
    assert main.cost_parts["cache_write_5m"].value == 2
    assert main.cache_ttl == "5m"
    assert main.cold_rewrites == Metric.exact(1)
    assert main.cold_rewrite_cost.value == 2


def test_agent_summary_counts_findings_on_owned_tool_nodes() -> None:
    finding = Finding(heuristic_id="E5", node_id="send", severity="low", message="resumed")
    tool = Node(node_id="send", kind=NodeKind.TOOL, topic="send", findings=[finding])
    turn = Node(node_id="turn", kind=NodeKind.TURN, topic="t", children=[tool])
    root = Node(node_id="root", kind=NodeKind.SESSION, topic="s", children=[turn])

    (main,) = agent_groups(root)

    assert main.findings_count == 1
