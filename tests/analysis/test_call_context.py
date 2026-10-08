from agentprof.analysis.call_context import annotate_call_context
from agentprof.model import LlmCall, Metric, Node, NodeKind, Tokens, ToolCategory, ToolInfo


def _call(start: int, duration: int | None = None) -> LlmCall:
    return LlmCall(
        start=Metric.exact(start), duration=Metric.exact(duration) if duration is not None else Metric.not_available()
    )


def test_main_agent_gap_crosses_turns_and_lists_user_and_tool_events() -> None:
    first = _call(10, 5)
    second = _call(50)
    tool = Node(
        node_id="tool-1",
        kind=NodeKind.TOOL,
        topic="read",
        tool=ToolInfo(native_id="Read", category=ToolCategory.READ),
        start=Metric.exact(20),
        end=Metric.exact(25),
        duration=Metric.exact(5),
    )
    root = Node(
        node_id="root",
        kind=NodeKind.SESSION,
        topic="s",
        children=[
            Node(
                node_id="turn-1",
                kind=NodeKind.TURN,
                topic="a",
                start=Metric.exact(0),
                llm_calls=[first],
                children=[tool],
            ),
            Node(node_id="turn-2", kind=NodeKind.TURN, topic="b", start=Metric.exact(30), llm_calls=[second]),
        ],
    )

    annotate_call_context(root)

    assert first.cold_reason == "first_call"
    assert second.gap == Metric.exact(35)
    assert second.gap_basis == "previous_end"
    assert [(event.kind, event.event_id) for event in second.preceding_events] == [
        ("tool", "tool-1"),
        ("user_message", "turn-2"),
    ]


def test_gap_uses_previous_start_when_call_end_is_unknown() -> None:
    first = _call(10)
    second = _call(50)
    root = Node(
        node_id="root",
        kind=NodeKind.SESSION,
        topic="s",
        children=[Node(node_id="turn", kind=NodeKind.TURN, topic="t", llm_calls=[first, second])],
    )

    annotate_call_context(root)

    assert second.gap == Metric.estimated(40)
    assert second.gap_basis == "previous_start"


def test_same_harness_agent_resumes_keep_their_call_sequence() -> None:
    first = _call(10)
    second = _call(100)
    root = Node(
        node_id="root",
        kind=NodeKind.SESSION,
        topic="s",
        children=[
            Node(node_id="agent-1", kind=NodeKind.AGENT, topic="first", agent_uuid="abc", llm_calls=[first]),
            Node(node_id="agent-2", kind=NodeKind.AGENT, topic="second", agent_uuid="abc", llm_calls=[second]),
        ],
    )

    annotate_call_context(root)

    assert second.gap == Metric.estimated(90)
    assert second.gap_basis == "previous_start"


def test_large_rewrite_requires_measured_low_reuse_and_a_previous_call() -> None:
    first = _call(10)
    first.tokens = Tokens(cache_write=Metric.exact(100_000), cache_read=Metric.exact(0))
    second = _call(100)
    second.tokens = Tokens(cache_write=Metric.exact(60_000), cache_read=Metric.exact(1_000))
    third = _call(200)
    third.tokens = Tokens(cache_write=Metric.exact(60_000), cache_read=Metric.exact(55_000))
    root = Node(
        node_id="root",
        kind=NodeKind.SESSION,
        topic="s",
        children=[Node(node_id="turn", kind=NodeKind.TURN, topic="t", llm_calls=[first, second, third])],
    )

    annotate_call_context(root)

    assert not first.cold_rewrite
    assert second.cold_rewrite
    assert not third.cold_rewrite
