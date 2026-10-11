from agentprof.analysis.finding_references import call_reference, event_reference, node_reference
from agentprof.model import ExecutionEvent, LlmCall, Metric, Node, NodeKind


def _owner() -> Node:
    return Node(node_id="turn-1", kind=NodeKind.TURN, topic="prompt")


def test_call_reference_uses_unique_native_id() -> None:
    owner = _owner()
    call = LlmCall(start=Metric.exact(10), call_id="call-1")

    reference = call_reference(owner, call, [call])

    assert reference is not None
    assert (reference.kind, reference.owner_id, reference.key) == ("call", "turn-1", "id:call-1")
    assert reference.label == "LLM call 1"


def test_duplicate_native_call_id_does_not_fall_back_to_timestamp() -> None:
    owner = _owner()
    first = LlmCall(start=Metric.exact(10), call_id="same")
    second = LlmCall(start=Metric.exact(10), call_id="same")

    assert call_reference(owner, first, [first, second]) is None


def test_call_without_native_id_uses_unique_exact_finite_start() -> None:
    owner = _owner()
    call = LlmCall(start=Metric.exact(12.5))

    reference = call_reference(owner, call, [call])

    assert reference is not None
    assert reference.key == "time:12.5"


def test_call_reference_preserves_large_integer_timestamp_and_stable_label() -> None:
    owner = _owner()
    call = LlmCall(start=Metric.exact(1_790_416_804_000))
    owner.llm_calls = [call]

    reference = call_reference(owner, call, [call])

    assert reference is not None
    assert reference.key == "time:1790416804000"
    assert reference.label == "LLM call 1"


def test_estimated_call_at_same_timestamp_makes_exact_fallback_ambiguous() -> None:
    owner = _owner()
    exact = LlmCall(start=Metric.exact(10))
    estimated = LlmCall(start=Metric.estimated(10))

    assert call_reference(owner, exact, [exact, estimated]) is None


def test_event_reference_requires_unique_event_id_within_owner() -> None:
    owner = _owner()
    first = ExecutionEvent(kind="resume", event_id="evt-1")
    duplicate = ExecutionEvent(kind="resume", event_id="evt-1")
    owner.execution_events = [first, duplicate]

    assert event_reference(owner, first) is None


def test_node_reference_uses_tool_name_as_label() -> None:
    node = Node(node_id="tool-1", kind=NodeKind.TOOL, topic="read file")

    reference = node_reference(node)

    assert (reference.kind, reference.owner_id, reference.key, reference.label) == (
        "node",
        "tool-1",
        "tool-1",
        "read file",
    )


def test_fractional_timestamp_key_uses_browser_numeric_spelling() -> None:
    owner = _owner()
    for timestamp, expected in ((0.00001, "time:0.00001"), (0.0000001, "time:1e-7")):
        call = LlmCall(start=Metric.exact(timestamp))
        owner.llm_calls = [call]
        reference = call_reference(owner, call, owner.llm_calls)
        assert reference is not None
        assert reference.key == expected
