# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

import copy
import json
from pathlib import Path
from typing import Any

from agentprof.adapters.copilot_vscode.debuglog import DebugLlmCall, DebugLog, load_debug_log_dir
from agentprof.adapters.copilot_vscode.session import parse_session_data
from agentprof.adapters.copilot_vscode.transcript import ToolEventRecord, ToolTiming, Transcript, load_transcript
from agentprof.adapters.copilot_vscode.tree import build_root
from agentprof.analysis.execution import resolve_execution_links
from agentprof.model import (
    CostMetric,
    LlmCall,
    Metric,
    Node,
    NodeKind,
    Provenance,
    Tokens,
    ToolCategory,
    ToolInfo,
    iter_nodes,
)

_FIXTURES = Path(__file__).parent / "fixtures"
_USD_PER_CREDIT = 0.01
_T0 = 1790121600000  # transcript fixture's first event
_REQUEST_START = 1790123020238  # export fixture's request timestamp


def _export_data() -> dict[str, Any]:
    return json.loads((_FIXTURES / "export_basic.json").read_text())


def _root_with_transcript() -> Node:
    raw = parse_session_data(_export_data())
    return build_root(
        raw,
        transcript=load_transcript(_FIXTURES / "transcript_basic.jsonl"),
        debug_log=None,
        usd_per_credit=_USD_PER_CREDIT,
    )


def _find(root: Node, node_id: str) -> Node:
    return next(n for n in iter_nodes(root) if n.node_id == node_id)


def test_build_root_nests_agents_and_tools_under_the_turn() -> None:
    root = _root_with_transcript()

    assert root.kind is NodeKind.SESSION
    turn = root.children[0]
    assert turn.kind is NodeKind.TURN
    assert [child.node_id for child in turn.children] == ["call_read_main", "call_lead"]
    lead = _find(root, "call_lead")
    assert lead.kind is NodeKind.AGENT
    assert lead.agent_uuid == "call_lead"
    exec_node = _find(root, "call_exec")
    assert exec_node.kind is NodeKind.AGENT
    assert exec_node in lead.children
    assert [child.node_id for child in exec_node.children] == ["call_read_child", "call_term_child"]
    assert _find(root, "call_read_child").kind is NodeKind.TOOL


def test_build_root_reports_credits_in_their_native_unit() -> None:
    root = _root_with_transcript()

    assert root.children[0].cost_total == CostMetric(
        value=42.0, unit="credits", provenance=Provenance.EXACT, usd_per_unit=_USD_PER_CREDIT
    )
    assert _find(root, "call_lead").cost_total == CostMetric(
        value=12.5, unit="credits", provenance=Provenance.EXACT, usd_per_unit=_USD_PER_CREDIT
    )
    # execution_subagent never reports its own credits.
    assert _find(root, "call_exec").cost_total == CostMetric.not_available()


def test_build_root_sets_turn_span_and_user_wait_from_the_request() -> None:
    turn = _root_with_transcript().children[0]

    assert turn.start == Metric.exact(_REQUEST_START)
    assert turn.end == Metric.exact(_REQUEST_START + 5000)
    assert turn.duration == Metric.exact(5000)
    assert turn.user_wait == Metric.exact(0)
    assert turn.prompt == "do the thing"
    assert turn.model == "copilot/claude-sonnet-5"


def test_build_root_sets_tool_timings_and_success_from_the_transcript() -> None:
    root = _root_with_transcript()

    read_main = _find(root, "call_read_main")
    assert read_main.start == Metric.exact(_T0 + 40)
    assert read_main.end == Metric.exact(_T0 + 240)
    assert read_main.duration == Metric.exact(200)
    assert read_main.success is True
    assert _find(root, "call_term_child").success is False
    turn = root.children[0]
    delegation_start = next(event for event in turn.execution_events if event.subject_node_id == "call_lead")
    delegation_result = next(
        event for event in turn.execution_events if event.kind == "tool_result" and event.subject_node_id == "call_lead"
    )
    assert delegation_start.kind == "delegation"
    assert delegation_start.source_order == 9
    assert delegation_result.source_order == 18
    assert not any(event.kind == "child_completion" for event in turn.execution_events)


def test_build_root_sets_tool_info() -> None:
    root = _root_with_transcript()

    assert _find(root, "call_read_main").tool == ToolInfo(
        native_id="copilot_readFile", category=ToolCategory.READ, path="foo.py", arguments={"filePath": "foo.py"}
    )
    # Nested-subagent tool calls have no arguments in the export; they come from the transcript.
    assert _find(root, "call_read_child").tool == ToolInfo(
        native_id="copilot_readFile", category=ToolCategory.READ, path="bar.py", arguments={"filePath": "bar.py"}
    )
    assert _find(root, "call_lead").tool == ToolInfo(native_id="runSubagent", category=ToolCategory.SUBAGENT)


def test_build_root_leaves_subagent_tool_arguments_empty_without_transcript() -> None:
    root = build_root(
        parse_session_data(_export_data()), transcript=None, debug_log=None, usd_per_credit=_USD_PER_CREDIT
    )

    assert _find(root, "call_read_child").tool == ToolInfo(native_id="copilot_readFile", category=ToolCategory.READ)


def test_build_root_takes_llm_calls_from_the_transcript_without_debug_log() -> None:
    root = _root_with_transcript()

    turn = root.children[0]
    assert [call.start for call in turn.llm_calls] == [Metric.exact(_T0 + 30), Metric.exact(_T0 + 270)]
    assert turn.llm_call_count == Metric.exact(2)
    assert turn.llm_calls[0].tokens == Tokens()
    assert _find(root, "call_lead").llm_call_count == Metric.exact(1)
    assert _find(root, "call_read_child").llm_call_count == Metric.not_available()
    assert turn.llm_calls[0].source_request_id == "m0"
    assert turn.llm_calls[0].timing_basis == "assistant_message"
    assert any(event.kind == "user_input" for event in root.execution_events)
    start_event = next(event for event in turn.execution_events if event.kind == "tool_start")
    assert start_event.links[0].source_request_id == "m0"
    assert start_event.links[0].relation == "requested_by"


def test_build_root_keeps_unaddressable_tool_records_on_the_session() -> None:
    raw = parse_session_data({"sessionId": "root_session", "requests": []})
    transcript = Transcript(
        tool_events=[
            ToolEventRecord("tool.execution_start", None, 100, 1, None, "read_file"),
            ToolEventRecord("tool.execution_complete", None, 200, 2, None, success=True),
        ]
    )

    root = build_root(raw, transcript, None, _USD_PER_CREDIT)

    assert [(event.kind, event.source_order, event.start.value) for event in root.execution_events] == [
        ("tool_start", 1, 100),
        ("tool_result", 2, 200),
    ]
    assert all(event.event_id is None and event.subject_node_id is None for event in root.execution_events)


def test_build_root_prefers_debug_log_calls_and_subtracts_cached_from_input() -> None:
    raw = parse_session_data(_export_data())
    transcript = load_transcript(_FIXTURES / "transcript_basic.jsonl")
    debug_log = load_debug_log_dir(_FIXTURES / "debug_log", root_session_id="root_session")

    root = build_root(raw, transcript=transcript, debug_log=debug_log, usd_per_credit=_USD_PER_CREDIT)

    assert _find(root, "call_lead").llm_calls == [
        LlmCall(
            start=Metric.exact(1040),
            duration=Metric.exact(5),
            tokens=Tokens(input=Metric.exact(20000), output=Metric.exact(200), cache_read=Metric.exact(60000)),
            source_request_id="span_llm_lead_1",
            model="claude-sonnet-5",
            source_stream_id="call_lead",
            timing_basis="request_start",
        )
    ]
    root_call = root.children[0].llm_calls[0]
    assert root_call.source_request_id == "span_llm_root_1"
    assert root_call.call_id is None
    assert root_call.timing_basis == "request_start"
    # call_exec has no debug-log file, so its calls come from the transcript.
    assert [call.start for call in _find(root, "call_exec").llm_calls] == [Metric.exact(_T0 + 320)]


def test_build_root_without_sources_leaves_llm_calls_not_available() -> None:
    root = build_root(
        parse_session_data(_export_data()), transcript=None, debug_log=None, usd_per_credit=_USD_PER_CREDIT
    )

    turn = root.children[0]
    assert turn.llm_calls == []
    assert turn.llm_call_count == Metric.not_available()
    assert _find(root, "call_read_main").start == Metric.not_available()


def test_build_root_splits_main_agent_llm_calls_between_turns() -> None:
    data = _export_data()
    second = copy.deepcopy(data["requests"][0])
    second["requestId"] = "request_002"
    second["timestamp"] = _REQUEST_START + 60_000
    second["response"] = []
    data["requests"].append(second)
    transcript = Transcript(
        llm_call_timestamps_ms={None: [_REQUEST_START + 10, _REQUEST_START + 20, _REQUEST_START + 60_010]}
    )

    root = build_root(parse_session_data(data), transcript=transcript, debug_log=None, usd_per_credit=_USD_PER_CREDIT)

    first_turn, second_turn = root.children
    assert [call.start.value for call in first_turn.llm_calls] == [_REQUEST_START + 10, _REQUEST_START + 20]
    assert [call.start.value for call in second_turn.llm_calls] == [_REQUEST_START + 60_010]


def test_build_root_treats_an_orphan_tool_call_as_a_direct_child_of_the_turn() -> None:
    data = _export_data()
    for part in data["requests"][0]["response"]:
        if part.get("toolCallId") == "call_read_main":
            part["subAgentInvocationId"] = "missing"

    raw = parse_session_data(data)
    root = build_root(raw, transcript=None, debug_log=None, usd_per_credit=_USD_PER_CREDIT)

    turn = root.children[0]
    assert "call_read_main" in [child.node_id for child in turn.children]


def _debug_call(start_ms: int, debug_name: str, input_tokens: int | None) -> DebugLlmCall:
    return DebugLlmCall(
        start_ms=start_ms,
        duration_ms=1,
        input_tokens=input_tokens,
        output_tokens=None if input_tokens is None else 10,
        cached_tokens=None if input_tokens is None else 0,
        debug_name=debug_name,
    )


def test_build_root_keeps_side_requests_out_of_the_context_and_missing_counts_unknown() -> None:
    raw = parse_session_data(_export_data())
    first = raw.requests[0].timestamp_ms
    debug_log = DebugLog(
        calls={
            None: [
                _debug_call(first + 1, "panel/editAgent", 1000),
                _debug_call(first + 2, "backgroundTodoAgent", 50),
                _debug_call(first + 3, "panel/editAgent", 1100),
                _debug_call(first + 4, "summarizeConversationHistory", None),
            ]
        }
    )

    root = build_root(raw, transcript=None, debug_log=debug_log, usd_per_credit=_USD_PER_CREDIT)

    calls = sorted((call for turn in root.children for call in turn.llm_calls), key=lambda call: call.start.number())
    assert [call.in_context for call in calls] == [True, False, True, False]
    assert calls[3].tokens == Tokens()


def test_debug_tool_relationships_resolve_and_keep_only_first_recorded_result_user() -> None:
    raw = parse_session_data(_export_data())
    transcript = Transcript(
        tool_timings={"call_read_main": ToolTiming(_REQUEST_START + 20, _REQUEST_START + 30, True, 1, 2, True)},
        tool_request_ids={"call_read_main": "transcript-message"},
    )
    debug = DebugLog(
        calls={
            None: [
                DebugLlmCall(
                    _REQUEST_START + 10,
                    5,
                    100,
                    10,
                    20,
                    source_request_id="span-request",
                    requested_tool_ids=("call_read_main",),
                ),
                DebugLlmCall(
                    _REQUEST_START + 15,
                    5,
                    100,
                    10,
                    20,
                    source_request_id="span-before-result",
                    consumed_tool_ids=("call_read_main",),
                ),
                DebugLlmCall(
                    _REQUEST_START + 40,
                    5,
                    100,
                    10,
                    20,
                    source_request_id="span-consumer",
                    consumed_tool_ids=("call_read_main",),
                ),
                DebugLlmCall(
                    _REQUEST_START + 50,
                    5,
                    100,
                    10,
                    20,
                    source_request_id="span-history",
                    consumed_tool_ids=("call_read_main",),
                ),
            ],
            "call_lead": [
                DebugLlmCall(
                    _REQUEST_START + 35,
                    5,
                    100,
                    10,
                    20,
                    source_request_id="span-other-agent",
                    consumed_tool_ids=("call_read_main",),
                )
            ],
        }
    )
    root = build_root(raw, transcript, debug, _USD_PER_CREDIT)
    resolve_execution_links(root)
    owner = root.children[0]
    events = [event for event in owner.execution_events if event.subject_node_id == "call_read_main"]
    requester = [link for link in events[0].links if link.relation == "requested_by"]
    consumer = [link for link in events[1].links if link.relation == "consumed_by"]
    assert [(link.source_request_id, link.owner_id, link.evidence) for link in requester] == [
        ("span-request", owner.node_id, "recorded")
    ]
    assert [(link.source_request_id, link.owner_id, link.evidence) for link in consumer] == [
        ("span-consumer", owner.node_id, "recorded")
    ]
    assert owner.llm_calls[0].source_request_id == "span-request"
    assert owner.llm_calls[0].tokens.input == Metric.exact(80)
    assert owner.llm_calls[0].duration == Metric.exact(5)


def test_debug_tool_relationships_do_not_guess_without_unique_request_or_recorded_input() -> None:
    raw = parse_session_data(_export_data())
    transcript = Transcript(
        tool_timings={"call_read_main": ToolTiming(_REQUEST_START + 20, _REQUEST_START + 30, True, 1, 2, True)},
        tool_request_ids={"call_read_main": "unmatched-message"},
    )
    debug = DebugLog(
        calls={
            None: [
                DebugLlmCall(
                    _REQUEST_START + 10,
                    5,
                    100,
                    10,
                    20,
                    source_request_id="span-a",
                    requested_tool_ids=("call_read_main",),
                ),
                DebugLlmCall(
                    _REQUEST_START + 11,
                    5,
                    100,
                    10,
                    20,
                    source_request_id="span-b",
                    requested_tool_ids=("call_read_main",),
                ),
                DebugLlmCall(_REQUEST_START + 40, 5, 100, 10, 20, source_request_id="span-next"),
            ]
        }
    )
    root = build_root(raw, transcript, debug, _USD_PER_CREDIT)
    resolve_execution_links(root)
    events = [event for event in root.children[0].execution_events if event.subject_node_id == "call_read_main"]
    assert all(link.owner_id is None for event in events for link in event.links)
    assert not any(link.relation == "consumed_by" for event in events for link in event.links)


def test_debug_billing_populates_main_and_nested_calls_without_changing_recorded_totals(tmp_path: Path) -> None:
    from agentprof.analysis.rollup import roll_up

    records = [
        {"type": "llm_request", "sid": owner, "ts": _REQUEST_START + index, "attrs": attrs}
        for index, (owner, attrs) in enumerate(
            [
                ("root", {"model": "main-model", "copilotUsageNanoAiu": 4946990000}),
                ("call_lead", {"model": "child-model", "copilotUsageNanoAiu": 2000000000}),
                ("call_lead", {"copilotUsageNanoAiu": 0}),
                ("call_lead", {}),
            ]
        )
    ]
    (tmp_path / "calls.jsonl").write_text("\n".join(json.dumps(record) for record in records))
    root = build_root(parse_session_data(_export_data()), None, load_debug_log_dir(tmp_path, "root"), 0.02)
    main = root.children[0].llm_calls[0]
    child = _find(root, "call_lead")
    assert main.model == "main-model"
    assert main.cost == CostMetric(value=4.94699, unit="credits", provenance=Provenance.EXACT, usd_per_unit=0.02)
    assert child.llm_calls[0].model == "child-model"
    assert child.llm_calls[0].cost.usd == 0.04
    assert child.llm_calls[1].cost.value == 0
    assert child.llm_calls[2].cost == CostMetric.not_available()
    roll_up(root)
    assert root.cost_total.value == 42.0
    assert child.cost_total.value == 12.5
