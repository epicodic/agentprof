from agentprof.analysis.finding_references import call_references, event_reference, node_reference
from agentprof.analysis.identity import assign_call_keys
from agentprof.model import ExecutionEvent, LlmCall, Metric, Node, NodeKind


def _owner() -> Node:
    return Node(node_id="turn-1", kind=NodeKind.TURN, topic="prompt")


def test_call_references_use_the_keys_assigned_by_the_pipeline() -> None:
    owner = _owner()
    call = LlmCall(start=Metric.exact(10), call_id="call-1")
    owner.llm_calls = [call]

    assert call_references(owner) == {}  # keys are assigned by the pipeline, not on demand

    assign_call_keys(owner)

    assert call_references(owner)[id(call)].key == call.call_key == "id:call-1"


def test_call_references_use_unique_native_id() -> None:
    owner = _owner()
    call = LlmCall(start=Metric.exact(10), call_id="call-1")
    owner.llm_calls = [call]
    assign_call_keys(owner)

    reference = call_references(owner)[id(call)]

    assert (reference.kind, reference.owner_id, reference.key) == ("call", "turn-1", "id:call-1")
    assert reference.label == "LLM call 1"


def test_call_references_skip_calls_without_a_unique_identity() -> None:
    owner = _owner()
    first = LlmCall(start=Metric.exact(10), call_id="same")
    second = LlmCall(start=Metric.exact(10), call_id="same")
    owner.llm_calls = [first, second]
    assign_call_keys(owner)

    assert call_references(owner) == {}


def test_call_references_label_by_position_in_the_owner() -> None:
    owner = _owner()
    first = LlmCall(start=Metric.exact(10), call_id="a")
    second = LlmCall(start=Metric.exact(20))
    owner.llm_calls = [first, second]
    assign_call_keys(owner)

    reference = call_references(owner)[id(second)]

    assert (reference.key, reference.label) == ("time:20", "LLM call 2")


def test_call_references_match_calls_by_identity_not_equality() -> None:
    owner = _owner()
    owner.llm_calls = [LlmCall(start=Metric.exact(1), call_id="a")]
    assign_call_keys(owner)
    other = LlmCall(start=Metric.exact(1), call_id="a", call_key=owner.llm_calls[0].call_key)

    assert other == owner.llm_calls[0]
    assert id(other) not in call_references(owner)


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
