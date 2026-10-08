# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import pytest

from agentprof.analysis.rollup import roll_up, sum_tokens
from agentprof.model import CostMetric, LlmCall, Metric, Node, NodeKind, Provenance, Tokens


def _credits(value: float) -> CostMetric:
    return CostMetric(value=value, unit="credits", provenance=Provenance.EXACT)


def _tool(node_id: str, start: int | None = None, end: int | None = None) -> Node:
    node = Node(node_id=node_id, kind=NodeKind.TOOL, topic="t")
    if start is not None:
        node.start = Metric.exact(start)
    if end is not None:
        node.end = Metric.exact(end)
    return node


def test_sum_tokens_adds_exact_counts() -> None:
    first = Tokens(input=Metric.exact(10), output=Metric.exact(1), cache_read=Metric.exact(100))
    second = Tokens(input=Metric.exact(20), output=Metric.exact(2), cache_read=Metric.exact(200))

    assert sum_tokens([first, second]) == Tokens(
        input=Metric.exact(30), output=Metric.exact(3), cache_read=Metric.exact(300)
    )


def test_sum_tokens_is_estimated_when_only_some_calls_have_a_count() -> None:
    first = Tokens(input=Metric.exact(10))
    second = Tokens()

    assert sum_tokens([first, second]).input == Metric.estimated(10)


def test_roll_up_sets_own_tokens_from_llm_calls() -> None:
    agent = Node(
        node_id="a",
        kind=NodeKind.AGENT,
        topic="a",
        llm_calls=[
            LlmCall(start=Metric.exact(0), tokens=Tokens(input=Metric.exact(5))),
            LlmCall(start=Metric.exact(1), tokens=Tokens(input=Metric.exact(7))),
        ],
    )

    roll_up(agent)

    assert agent.tokens.input == Metric.exact(12)
    assert agent.tokens.cache_write == Metric.not_available()


def test_roll_up_leaves_tokens_not_available_without_llm_calls() -> None:
    agent = Node(node_id="a", kind=NodeKind.AGENT, topic="a")

    roll_up(agent)

    assert agent.tokens == Tokens()


def test_roll_up_derives_span_from_children() -> None:
    agent = Node(node_id="a", kind=NodeKind.AGENT, topic="a", children=[_tool("t1", 100, 200), _tool("t2", 150, 400)])

    roll_up(agent)

    assert agent.start == Metric.exact(100)
    assert agent.end == Metric.estimated(400)
    assert agent.duration == Metric.estimated(300)


def test_roll_up_span_is_estimated_when_a_child_lacks_timing() -> None:
    agent = Node(node_id="a", kind=NodeKind.AGENT, topic="a", children=[_tool("t1", 100, 200), _tool("t2")])

    roll_up(agent)

    assert agent.start == Metric.estimated(100)
    assert agent.duration == Metric.estimated(100)


def test_roll_up_span_includes_own_llm_calls() -> None:
    agent = Node(
        node_id="a",
        kind=NodeKind.AGENT,
        topic="a",
        children=[_tool("t1", 100, 200)],
        llm_calls=[LlmCall(start=Metric.exact(50), duration=Metric.exact(500))],
    )

    roll_up(agent)

    assert agent.start == Metric.exact(50)
    assert agent.end == Metric.estimated(550)


def test_roll_up_keeps_an_existing_span() -> None:
    turn = Node(
        node_id="t",
        kind=NodeKind.TURN,
        topic="t",
        start=Metric.exact(0),
        end=Metric.exact(1000),
        duration=Metric.exact(1000),
        children=[_tool("t1", 100, 5000)],
    )

    roll_up(turn)

    assert turn.end == Metric.exact(1000)


def test_roll_up_span_of_parent_uses_rolled_up_children() -> None:
    inner = Node(node_id="a", kind=NodeKind.AGENT, topic="a", children=[_tool("t1", 100, 200)])
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[inner])

    roll_up(root)

    assert root.start == Metric.exact(100)
    assert root.end == Metric.estimated(200)


def test_roll_up_own_cost_subtracts_agent_children_and_ignores_tools() -> None:
    lead = Node(node_id="lead", kind=NodeKind.AGENT, topic="l", cost_total=_credits(12.5))
    turn = Node(node_id="t", kind=NodeKind.TURN, topic="t", cost_total=_credits(42.0), children=[_tool("x"), lead])

    roll_up(turn)

    assert turn.cost_own == _credits(29.5)
    assert lead.cost_own == _credits(12.5)


def test_roll_up_own_cost_is_estimated_when_an_agent_child_lacks_cost() -> None:
    silent = Node(node_id="exec", kind=NodeKind.AGENT, topic="e")
    lead = Node(node_id="lead", kind=NodeKind.AGENT, topic="l", cost_total=_credits(12.5), children=[silent])

    roll_up(lead)

    assert lead.cost_own == CostMetric(value=12.5, unit="credits", provenance=Provenance.ESTIMATED)


def test_roll_up_own_cost_does_not_subtract_a_different_unit() -> None:
    child = Node(
        node_id="c",
        kind=NodeKind.AGENT,
        topic="c",
        cost_total=CostMetric(value=1.0, unit="USD", provenance=Provenance.ESTIMATED),
    )
    turn = Node(node_id="t", kind=NodeKind.TURN, topic="t", cost_total=_credits(10.0), children=[child])

    roll_up(turn)

    assert turn.cost_own == CostMetric(value=10.0, unit="credits", provenance=Provenance.ESTIMATED)


def test_roll_up_own_cost_stays_not_available_without_total() -> None:
    agent = Node(node_id="a", kind=NodeKind.AGENT, topic="a")

    roll_up(agent)

    assert agent.cost_own == CostMetric.not_available()


def test_roll_up_estimates_the_end_of_a_call_without_duration() -> None:
    agent = Node(node_id="a", kind=NodeKind.AGENT, topic="a", llm_calls=[LlmCall(start=Metric.exact(50))])

    roll_up(agent)

    assert agent.start == Metric.exact(50)
    assert agent.end == Metric.estimated(50)


def _usd(value: float) -> CostMetric:
    return CostMetric(value=value, unit="USD", provenance=Provenance.ESTIMATED)


def _call(cost: CostMetric, input_tokens: int = 10) -> LlmCall:
    return LlmCall(start=Metric.exact(0), tokens=Tokens(input=Metric.exact(input_tokens)), cost=cost)


def test_roll_up_sums_own_cost_from_llm_calls_and_total_from_children() -> None:
    child = Node(node_id="c", kind=NodeKind.AGENT, topic="c", llm_calls=[_call(_usd(0.5))])
    agent = Node(
        node_id="a", kind=NodeKind.AGENT, topic="a", llm_calls=[_call(_usd(1.0)), _call(_usd(2.0))], children=[child]
    )

    roll_up(agent)

    assert agent.cost_own == _usd(3.0)
    assert child.cost_total == _usd(0.5)
    assert agent.cost_total == _usd(3.5)


def test_roll_up_own_cost_from_calls_is_estimated_when_a_call_lacks_cost() -> None:
    agent = Node(
        node_id="a", kind=NodeKind.AGENT, topic="a", llm_calls=[_call(_usd(1.0)), _call(CostMetric.not_available())]
    )

    roll_up(agent)

    assert agent.cost_own == CostMetric(value=1.0, unit="USD", provenance=Provenance.ESTIMATED)


def test_roll_up_session_total_is_the_sum_of_its_turns() -> None:
    turns = [Node(node_id=f"t{i}", kind=NodeKind.TURN, topic="t", cost_total=_credits(float(i + 1))) for i in range(2)]
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=turns)

    roll_up(root)

    assert root.cost_total == _credits(3.0)


def test_roll_up_total_is_not_available_for_mixed_units() -> None:
    turns = [
        Node(node_id="t1", kind=NodeKind.TURN, topic="t", cost_total=_credits(1.0)),
        Node(node_id="t2", kind=NodeKind.TURN, topic="t", cost_total=_usd(1.0)),
    ]
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=turns)

    roll_up(root)

    assert root.cost_total == CostMetric.not_available()


def test_roll_up_keeps_a_given_total_and_subtracts_children() -> None:
    lead = Node(node_id="lead", kind=NodeKind.AGENT, topic="l", cost_total=_credits(2.0))
    turn = Node(
        node_id="t",
        kind=NodeKind.TURN,
        topic="t",
        cost_total=_credits(5.0),
        llm_calls=[_call(CostMetric.not_available())],
        children=[lead],
    )

    roll_up(turn)

    assert turn.cost_total == _credits(5.0)
    assert turn.cost_own == _credits(3.0)


def test_roll_up_tokens_total_adds_worker_children_and_ignores_tools() -> None:
    child = Node(node_id="c", kind=NodeKind.AGENT, topic="c", llm_calls=[_call(_usd(0.1), input_tokens=5)])
    turn = Node(
        node_id="t",
        kind=NodeKind.TURN,
        topic="t",
        llm_calls=[_call(_usd(0.1), input_tokens=10)],
        children=[_tool("x"), child],
    )
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[turn])

    roll_up(root)

    assert turn.tokens.input == Metric.exact(10)
    assert turn.tokens_total.input == Metric.exact(15)
    assert root.tokens_total.input == Metric.exact(15)
    assert root.tokens == Tokens()


def test_roll_up_tokens_total_is_estimated_when_a_worker_lacks_tokens() -> None:
    silent = Node(node_id="c", kind=NodeKind.AGENT, topic="c")
    turn = Node(node_id="t", kind=NodeKind.TURN, topic="t", llm_calls=[_call(_usd(0.1))], children=[silent])

    roll_up(turn)

    assert turn.tokens_total.input == Metric.estimated(10)


def test_roll_up_sets_tool_call_count_for_every_node() -> None:
    leaf = _tool("leaf")
    agent = Node(node_id="a", kind=NodeKind.AGENT, topic="a", children=[leaf, _tool("other")])
    root = Node(node_id="session", kind=NodeKind.SESSION, topic="s", children=[agent])

    roll_up(root)

    assert root.tool_call_count == Metric.exact(1)
    assert agent.tool_call_count == Metric.exact(2)
    assert leaf.tool_call_count == Metric.exact(0)


def test_roll_up_leaves_own_cost_unknown_when_children_exceed_the_total() -> None:
    lead = Node(node_id="lead", kind=NodeKind.AGENT, topic="l", cost_total=_credits(46.0))
    turn = Node(node_id="t", kind=NodeKind.TURN, topic="t", cost_total=_credits(30.0), children=[lead])

    roll_up(turn)

    assert turn.cost_own == CostMetric.not_available()
    assert turn.cost_total == _credits(30.0)


def _sized_call(start: int, size: int) -> LlmCall:
    return LlmCall(start=Metric.exact(start), tokens=Tokens(input=Metric.exact(size)))


def test_roll_up_sets_the_context_peak_of_own_calls() -> None:
    turn = Node(
        node_id="t",
        kind=NodeKind.TURN,
        topic="t",
        llm_calls=[_sized_call(0, 100), _sized_call(10, 300), _sized_call(20, 200)],
    )

    roll_up(turn)

    assert turn.context_peak == Metric.exact(300)


def test_roll_up_detects_compactions_as_drops_below_half() -> None:
    agent = Node(
        node_id="a",
        kind=NodeKind.AGENT,
        topic="a",
        llm_calls=[_sized_call(20, 50), _sized_call(0, 100), _sized_call(10, 120), _sized_call(30, 60)],
    )

    roll_up(agent)

    assert agent.compactions == [Metric.estimated(20)]


def test_roll_up_keeps_compactions_set_by_the_adapter() -> None:
    turn = Node(
        node_id="t",
        kind=NodeKind.TURN,
        topic="t",
        llm_calls=[_sized_call(0, 100), _sized_call(10, 10)],
        compactions=[Metric.exact(5)],
    )

    roll_up(turn)

    assert turn.compactions == [Metric.exact(5)]


def test_roll_up_leaves_context_empty_without_sized_calls() -> None:
    turn = Node(node_id="t", kind=NodeKind.TURN, topic="t", llm_calls=[LlmCall(start=Metric.exact(0))])

    roll_up(turn)

    assert turn.context_peak == Metric.not_available()
    assert turn.compactions == []


def test_roll_up_leaves_calls_outside_the_context_out_of_peak_and_detection() -> None:
    side = _sized_call(15, 5)
    side.in_context = False
    agent = Node(
        node_id="a",
        kind=NodeKind.AGENT,
        topic="a",
        llm_calls=[_sized_call(0, 100), _sized_call(10, 120), side, _sized_call(20, 130)],
    )
    side_peak = Node(node_id="b", kind=NodeKind.AGENT, topic="b", llm_calls=[_sized_call(0, 10)])
    side_peak.llm_calls[0].in_context = False

    roll_up(agent)
    roll_up(side_peak)

    assert agent.context_peak == Metric.exact(130)
    assert agent.compactions == []
    assert side_peak.context_peak == Metric.not_available()


def test_roll_up_detects_a_compaction_of_the_main_agent_across_turns() -> None:
    first = Node(node_id="t1", kind=NodeKind.TURN, topic="t1", llm_calls=[_sized_call(0, 100), _sized_call(10, 180)])
    second = Node(node_id="t2", kind=NodeKind.TURN, topic="t2", llm_calls=[_sized_call(20, 50), _sized_call(30, 60)])
    session = Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[first, second])

    roll_up(session)

    assert first.compactions == []
    assert second.compactions == [Metric.estimated(20)]


def test_roll_up_does_not_detect_compactions_in_a_turn_with_recorded_ones() -> None:
    first = Node(node_id="t1", kind=NodeKind.TURN, topic="t1", llm_calls=[_sized_call(0, 100)])
    second = Node(
        node_id="t2",
        kind=NodeKind.TURN,
        topic="t2",
        llm_calls=[_sized_call(20, 40)],
        compactions=[Metric.exact(15)],
    )
    session = Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[first, second])

    roll_up(session)

    assert second.compactions == [Metric.exact(15)]


def test_roll_up_session_context_spans_all_turns() -> None:
    first = Node(node_id="t1", kind=NodeKind.TURN, topic="t1", llm_calls=[_sized_call(0, 100), _sized_call(10, 180)])
    second = Node(
        node_id="t2",
        kind=NodeKind.TURN,
        topic="t2",
        llm_calls=[_sized_call(20, 50), _sized_call(30, 60)],
        compactions=[Metric.exact(15)],
    )
    session = Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[first, second])

    roll_up(session)

    assert session.context_peak == Metric.exact(180)
    assert session.compactions == [Metric.exact(15)]
    assert session.llm_calls == []


def test_roll_up_session_context_is_empty_without_sized_turns() -> None:
    turn = Node(node_id="t", kind=NodeKind.TURN, topic="t")
    session = Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[turn])

    roll_up(session)

    assert session.context_peak == Metric.not_available()
    assert session.compactions == []


def test_roll_up_keeps_the_usd_rate_of_summed_and_own_costs() -> None:
    def credits(value: float) -> CostMetric:
        return CostMetric(value=value, unit="credits", provenance=Provenance.EXACT, usd_per_unit=0.01)

    lead = Node(node_id="lead", kind=NodeKind.AGENT, topic="l", cost_total=credits(2.0))
    turn = Node(node_id="t", kind=NodeKind.TURN, topic="t", cost_total=credits(5.0), children=[lead])
    session = Node(node_id="s", kind=NodeKind.SESSION, topic="s", children=[turn])

    roll_up(session)

    assert session.cost_total.usd == pytest.approx(0.05)
    assert turn.cost_own.usd == pytest.approx(0.03)
