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
        duration=Metric.exact(20),
        tokens=Tokens(input=Metric.exact(20), output=Metric.exact(2)),
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
        duration=Metric.exact(40),
        tokens=Tokens(input=Metric.exact(30), output=Metric.exact(3)),
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
        duration=Metric.exact(69),
        tokens=Tokens(input=Metric.exact(70), output=Metric.exact(7)),
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
        duration=Metric.exact(10),
        tokens=Tokens(input=Metric.exact(10), output=Metric.exact(1)),
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
    assert main.duration == Metric.exact(79)
    assert lead_group.duration == Metric.exact(40)
    assert worker_group.duration == Metric.exact(20)
    assert main.tokens_in_out == Metric.exact(70 + 10 + 7 + 1)


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


def test_agent_duration_is_estimated_when_a_turn_lacks_one() -> None:
    timed = Node(node_id="u1", kind=NodeKind.TURN, topic="a", duration=Metric.exact(5))
    untimed = Node(node_id="u2", kind=NodeKind.TURN, topic="b")
    root = Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[timed, untimed])

    (main,) = agent_groups(root)

    assert main.duration == Metric.estimated(5)


def test_agent_summary_counts_resumes_and_drops_placeholder_models() -> None:
    agent = Node(
        node_id="agent",
        kind=NodeKind.AGENT,
        topic="a",
        agent_uuid="a-id",
        resume_times=[Metric.exact(10), Metric.exact(20)],
        llm_calls=[
            LlmCall(start=Metric.exact(1), model="real-model"),
            LlmCall(start=Metric.exact(1), model="<synthetic>"),
        ],
    )
    placeholder_only = Node(
        node_id="other",
        kind=NodeKind.AGENT,
        topic="o",
        agent_uuid="o-id",
        llm_calls=[LlmCall(start=Metric.exact(1), model="<synthetic>")],
    )
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[agent, placeholder_only])

    _, first, second = agent_groups(root)

    assert first.resume_count == 2
    assert first.models == ["real-model"]
    assert second.resume_count == 0
    assert second.models == []


def test_agent_summary_labels_cache_ttl_from_known_write_splits() -> None:
    def write(five: int, one: int | None) -> LlmCall:
        return LlmCall(
            start=Metric.exact(1),
            tokens=Tokens(
                cache_write=Metric.exact(five + (one or 0) or 1),
                cache_write_5m=Metric.exact(five),
                cache_write_1h=Metric.exact(one) if one is not None else Metric.not_available(),
            ),
        )

    def group(*calls: LlmCall):
        turn = Node(node_id="turn", kind=NodeKind.TURN, topic="t", llm_calls=list(calls))
        (main,) = agent_groups(Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[turn]))
        return main

    assert group(write(5, 0), write(0, 5)).cache_ttl == "mixed"
    assert group(write(0, 5)).cache_ttl == "1h"
    assert group(write(5, 0), write(5, None)).cache_ttl == "unknown"
    assert group().cache_ttl == "unknown"
