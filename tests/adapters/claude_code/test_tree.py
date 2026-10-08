# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from pathlib import Path

import pytest

from agentprof.adapters.claude_code.discovery import Subagent, SubagentMeta, load_subagents
from agentprof.adapters.claude_code.transcript import (
    AssistantMessage,
    Prompt,
    ToolResult,
    ToolUse,
    Transcript,
    load_transcript,
)
from agentprof.adapters.claude_code.tree import build_root, first_line, usage_of
from agentprof.analysis.rollup import roll_up
from agentprof.model import Metric, Node, NodeKind, Provenance, Tokens, ToolCategory, iter_nodes
from agentprof.pricing import PriceTable, Usage

_PROJECT = Path(__file__).parent / "fixtures" / "projects" / "-home-user-demo"
_MAIN = _PROJECT / "11111111-1111-4111-8111-111111111111.jsonl"
_T0 = 1789898400000


def _root() -> Node:
    return build_root(load_transcript(_MAIN), load_subagents(_MAIN), PriceTable.load(), "Fix the parser")


def _find(root: Node, node_id: str) -> Node:
    return next(node for node in iter_nodes(root) if node.node_id == node_id)


def test_usage_of_splits_cache_writes_by_duration() -> None:
    usage = usage_of(
        {
            "input_tokens": 1,
            "output_tokens": 2,
            "cache_read_input_tokens": 3,
            "cache_creation_input_tokens": 10,
            "cache_creation": {"ephemeral_5m_input_tokens": 4, "ephemeral_1h_input_tokens": 6},
        }
    )

    assert usage == Usage(input=1, output=2, cache_read=3, cache_write_5m=4, cache_write_1h=6)


def test_usage_of_prices_unsplit_cache_writes_at_the_five_minute_rate() -> None:
    assert usage_of({"cache_creation_input_tokens": 7}).cache_write_5m == 7


def test_call_preserves_explicit_cache_ttl_and_cost_parts() -> None:
    main = Transcript(
        prompts=[Prompt(uuid="p", start_ms=0, text="start")],
        messages=[
            AssistantMessage(
                message_id="call-1",
                start_ms=1,
                model="claude-sonnet-5-20260101",
                usage={
                    "input_tokens": 2,
                    "output_tokens": 3,
                    "cache_read_input_tokens": 4,
                    "cache_creation_input_tokens": 10,
                    "cache_creation": {"ephemeral_5m_input_tokens": 6, "ephemeral_1h_input_tokens": 4},
                },
            )
        ],
    )
    call = build_root(main, [], PriceTable.load(), "s").children[0].llm_calls[0]

    assert call.call_id == "call-1"
    assert call.tokens.cache_write == Metric.exact(10)
    assert call.tokens.cache_write_5m == Metric.exact(6)
    assert call.tokens.cache_write_1h == Metric.exact(4)
    assert call.price_prefix == "claude-sonnet-5"
    assert set(call.cost_parts) == {"input", "output", "cache_read", "cache_write_5m", "cache_write_1h"}
    assert sum(part.value or 0 for part in call.cost_parts.values()) == pytest.approx(call.cost.value)


def test_call_does_not_claim_a_ttl_split_when_only_total_is_reported() -> None:
    main = Transcript(
        prompts=[Prompt(uuid="p", start_ms=0, text="start")],
        messages=[
            AssistantMessage(
                message_id="call-1", start_ms=1, model="claude-sonnet-5", usage={"cache_creation_input_tokens": 7}
            )
        ],
    )
    call = build_root(main, [], PriceTable.load(), "s").children[0].llm_calls[0]

    assert call.tokens.cache_write == Metric.exact(7)
    assert call.tokens.cache_write_5m == Metric.not_available()
    assert call.tokens.cache_write_1h == Metric.not_available()
    assert call.cost_parts["cache_write_5m"].value is None
    assert call.cost_parts["cache_write_1h"].value is None


def test_first_line_skips_blank_lines_and_truncates() -> None:
    assert first_line("\n  hello world\nsecond", 5) == "hello"


def test_build_root_creates_one_turn_per_prompt() -> None:
    root = _root()

    assert root.kind is NodeKind.SESSION
    assert root.topic == "Fix the parser"
    assert [(t.node_id, t.kind, t.topic, t.start) for t in root.children] == [
        ("u1", NodeKind.TURN, "Fix the parser", Metric.exact(_T0)),
        ("u2", NodeKind.TURN, "Now run the tests", Metric.exact(_T0 + 600_000)),
    ]


def test_build_root_retains_prompt_only_turns_and_preserves_compactions() -> None:
    main = Transcript(
        prompts=[
            Prompt(uuid="first", start_ms=0, text="Start"),
            Prompt(uuid="compact", start_ms=10, text="/compact"),
            Prompt(uuid="summary", start_ms=11, text="This session is being continued"),
            Prompt(uuid="output", start_ms=12, text="<local-command-stdout>Compacted</local-command-stdout>"),
            Prompt(uuid="second", start_ms=20, text="Continue"),
            Prompt(uuid="notification", start_ms=30, text="<task-notification>Stopped</task-notification>"),
        ],
        messages=[
            AssistantMessage(message_id="m1", start_ms=1, model="claude-sonnet-5"),
            AssistantMessage(message_id="m2", start_ms=21, model="claude-sonnet-5"),
        ],
        compactions_ms=[15],
    )

    root = build_root(main, [], PriceTable.load(), "session")

    assert [turn.node_id for turn in root.children] == [
        "first",
        "compact",
        "summary",
        "output",
        "second",
        "notification",
    ]
    assert root.children[3].compactions == [Metric.exact(15)]
    compaction_events = [
        event for turn in root.children for event in turn.execution_events if event.kind == "compaction"
    ]
    assert len(compaction_events) == 1
    compaction_event = compaction_events[0]
    assert compaction_event.start == Metric.exact(15)
    assert compaction_event.subject_node_id == "output"
    assert compaction_event.event_id is None
    assert compaction_event.source_order is None
    assert compaction_event.execution_start.value is None
    assert compaction_event.execution_end.value is None
    assert compaction_event.links == []
    assert all(any(event.kind == "user_input" for event in turn.execution_events) for turn in root.children)


def test_build_root_does_not_record_synthetic_prompt_as_user_input() -> None:
    main = Transcript(messages=[AssistantMessage(message_id="message", start_ms=10, model="claude-sonnet-5")])

    root = build_root(main, [], PriceTable.load(), "session")

    assert [turn.node_id for turn in root.children] == ["turn-1"]
    assert root.children[0].execution_events == []


def test_build_root_does_not_emit_events_for_inferred_compactions() -> None:
    main = Transcript(
        prompts=[Prompt(uuid="turn", start_ms=0, text="continue")],
        messages=[
            AssistantMessage(message_id="m1", start_ms=10, model="claude-sonnet-5", usage={"input_tokens": 100}),
            AssistantMessage(message_id="m2", start_ms=20, model="claude-sonnet-5", usage={"input_tokens": 10}),
        ],
    )

    root = build_root(main, [], PriceTable.load(), "session")
    roll_up(root)

    assert root.children[0].compactions == [Metric.estimated(20)]
    assert all(event.kind != "compaction" for node in iter_nodes(root) for event in node.execution_events)


def test_build_root_keeps_exact_compaction_metadata_without_a_turn() -> None:
    main = Transcript(compactions_ms=[42], source_stream_id="claude-code:session")

    root = build_root(main, [], PriceTable.load(), "session")

    assert root.children == []
    assert root.compactions == []
    assert len(root.execution_events) == 1
    event = root.execution_events[0]
    assert event.kind == "compaction"
    assert event.start == Metric.exact(42)
    assert event.event_id is None
    assert event.source_order is None
    assert event.subject_node_id is None
    assert event.source_stream_id == "claude-code:session"
    assert event.execution_start.value is None
    assert event.execution_end.value is None
    assert event.links == []


def test_build_root_preserves_orphan_result_without_fabricating_a_turn() -> None:
    result = ToolResult(end_ms=20, is_error=True, text="", source_order=1, next_message_id=None)
    main = Transcript(
        tool_results={"orphan": result},
        tool_result_records=[("orphan", result)],
        source_stream_id="claude-code:session",
    )

    root = build_root(main, [], PriceTable.load(), "session")

    assert root.children == []
    assert len(root.execution_events) == 1
    event = root.execution_events[0]
    assert event.kind == "tool_result"
    assert event.event_id == "tool-result:orphan"
    assert event.subject_node_id is None
    assert event.start == Metric.exact(20)
    assert event.execution_start.value is None
    assert event.execution_end == Metric.exact(20)
    assert event.success is False
    assert event.links == []
    assert all(event.kind != "user_input" for event in root.execution_events)


def test_build_root_emits_every_duplicate_result_record_with_duplicate_event_ids() -> None:
    first = ToolResult(end_ms=2, is_error=False, text="first", source_order=2)
    second = ToolResult(end_ms=3, is_error=True, text="last", source_order=3)
    main = Transcript(
        prompts=[Prompt(uuid="turn", start_ms=0, text="Run it", source_order=0)],
        tool_uses=[ToolUse(tool_use_id="call", name="Bash", input={}, start_ms=1, source_order=1)],
        tool_results={"call": second},
        tool_result_records=[("call", first), ("call", second)],
        source_stream_id="claude-code:session",
    )

    root = build_root(main, [], PriceTable.load(), "session")
    results = [event for event in root.children[0].execution_events if event.kind == "tool_result"]

    assert len(results) == 2
    assert [event.event_id for event in results] == ["tool-result:call", "tool-result:call"]
    assert [event.source_order for event in results] == [2, 3]
    assert [event.success for event in results] == [True, False]


def test_build_root_keeps_a_turn_with_only_tool_activity() -> None:
    main = Transcript(
        prompts=[Prompt(uuid="tool-turn", start_ms=0, text="Run a tool")],
        tool_uses=[ToolUse(tool_use_id="tool", name="Bash", input={}, start_ms=1)],
    )

    root = build_root(main, [], PriceTable.load(), "session")

    assert [turn.node_id for turn in root.children] == ["tool-turn"]
    assert [child.node_id for child in root.children[0].children] == ["tool"]


def test_build_root_splits_main_items_between_turns() -> None:
    first, second = _root().children

    assert [c.node_id for c in first.children] == ["toolu_read1", "toolu_agent1", "toolu_ask1"]
    assert [c.node_id for c in second.children] == ["toolu_bash1", "toolu_fancy1", "agent-ccc"]
    assert first.llm_call_count == Metric.exact(4)
    assert second.llm_call_count == Metric.exact(3)
    assert first.model == "claude-sonnet-5"


def test_build_root_prices_each_llm_call() -> None:
    call = _root().children[0].llm_calls[0]

    assert call.start == Metric.exact(_T0 + 1000)
    assert call.model == "claude-sonnet-5"
    assert call.tokens == Tokens(
        input=Metric.exact(100),
        output=Metric.exact(40),
        cache_read=Metric.exact(1000),
        cache_write=Metric.exact(500),
        cache_write_5m=Metric.exact(500),
        cache_write_1h=Metric.exact(0),
    )
    assert call.cost.unit == "USD"
    assert call.cost.provenance is Provenance.ESTIMATED
    assert call.cost.value == pytest.approx(0.00205)


def test_build_root_leaves_the_cost_of_an_unknown_model_unavailable() -> None:
    unknown = next(c for c in _root().children[1].llm_calls if c.model == "claude-unknown-9")

    assert unknown.cost.value is None


def test_build_root_times_tool_calls_from_use_to_result() -> None:
    root = _root()

    read = _find(root, "toolu_read1")
    assert read.kind is NodeKind.TOOL
    assert (read.start, read.end, read.duration) == (
        Metric.exact(_T0 + 1200),
        Metric.exact(_T0 + 2000),
        Metric.exact(800),
    )
    assert read.success is True
    assert read.result == "   10\tdef parse():"
    assert read.tool is not None
    assert (read.tool.category, read.tool.path, read.tool.line_range) == (
        ToolCategory.READ,
        "/home/user/demo/parser.py",
        (10, 29),
    )
    assert read.topic == "Read: /home/user/demo/parser.py"
    assert _find(root, "toolu_bash1").success is False
    assert _find(root, "toolu_fancy1").end == Metric.not_available()


def test_build_root_emits_source_ordered_tool_events_without_consumption_claims() -> None:
    root = _root()
    turn = root.children[0]
    read = _find(root, "toolu_read1")
    start = next(
        event for event in turn.execution_events if event.kind == "tool_start" and event.subject_node_id == read.node_id
    )
    result = next(
        event
        for event in turn.execution_events
        if event.kind == "tool_result" and event.subject_node_id == read.node_id
    )

    assert start.event_id == "tool-start:toolu_read1"
    assert start.source_stream_id == "claude-code:11111111-1111-4111-8111-111111111111"
    assert start.source_order is not None
    assert start.links[0].source_request_id == "msg_1"
    assert start.links[0].relation == "requested_by"
    call = turn.llm_calls[0]
    assert (call.source_request_id, call.source_stream_id, call.timing_basis) == (
        "msg_1",
        "claude-code:11111111-1111-4111-8111-111111111111",
        "assistant_message",
    )
    assert call.source_order is not None
    assert result.source_order is not None and result.source_order > start.source_order
    assert result.start == Metric.exact(_T0 + 2000)
    assert [(link.relation, link.source_request_id) for link in result.links] == [
        ("requested_by", "msg_1"),
        ("next_observed_call", "msg_2"),
    ]
    assert all(
        link.relation != "consumed_by"
        for node in iter_nodes(root)
        for event in node.execution_events
        for link in event.links
    )


def test_async_agent_acknowledgement_is_a_delegation_result_not_child_completion() -> None:
    tool_use_id = "agent-call"
    main = Transcript(
        prompts=[Prompt(uuid="turn", start_ms=0, text="delegate", source_order=0)],
        tool_uses=[ToolUse(tool_use_id=tool_use_id, name="Agent", input={}, start_ms=1, source_order=1)],
        tool_results={
            tool_use_id: ToolResult(end_ms=2, is_error=False, text="Async agent launched successfully.", source_order=2)
        },
        tool_result_records=[
            (
                tool_use_id,
                ToolResult(end_ms=2, is_error=False, text="Async agent launched successfully.", source_order=2),
            )
        ],
        source_stream_id="claude-code:session",
    )
    child = Transcript(source_stream_id="claude-code:child")
    subagent = Subagent(
        meta=SubagentMeta(agent_id="child", tool_use_id=tool_use_id, agent_type=None, description="child", model=None),
        transcript=child,
    )

    root = build_root(main, [subagent], PriceTable.load(), "t")
    turn = root.children[0]
    delegation = next(event for event in turn.execution_events if event.kind == "delegation")

    assert delegation.kind == "delegation"
    assert delegation.start == Metric.exact(1)
    assert delegation.execution_end == Metric.exact(2)
    assert all(event.kind != "child_completion" for node in iter_nodes(root) for event in node.execution_events)


def test_unattached_failed_subagent_tool_keeps_delegation_event_kind() -> None:
    main = Transcript(
        prompts=[Prompt(uuid="turn", start_ms=0, text="delegate", source_order=0)],
        tool_uses=[ToolUse(tool_use_id="task-call", name="Task", input={}, start_ms=1, source_order=1)],
        tool_results={"task-call": ToolResult(end_ms=2, is_error=True, text="failed", source_order=2)},
        source_stream_id="claude-code:session",
    )

    root = build_root(main, [], PriceTable.load(), "t")
    events = root.children[0].execution_events
    delegation = next(event for event in events if event.kind in {"delegation", "tool_start"})
    task_node = _find(root, "task-call")

    assert task_node.tool is not None
    assert task_node.tool.category is ToolCategory.SUBAGENT
    assert delegation.kind == "delegation"
    assert delegation.subject_node_id == "task-call"
    assert next(event for event in events if event.kind == "tool_result").success is False


def test_execution_events_follow_interleaved_source_order() -> None:
    result = ToolResult(end_ms=3, is_error=False, text="done", source_order=3)
    main = Transcript(
        prompts=[Prompt(uuid="turn", start_ms=0, text="run both", source_order=0)],
        tool_uses=[
            ToolUse(tool_use_id="call-a", name="Bash", input={}, start_ms=1, source_order=1),
            ToolUse(tool_use_id="call-b", name="Read", input={}, start_ms=2, source_order=2),
        ],
        tool_results={"call-a": result},
        tool_result_records=[("call-a", result)],
        source_stream_id="claude-code:session",
    )

    root = build_root(main, [], PriceTable.load(), "session")
    events = root.children[0].execution_events

    assert [event.source_order for event in events] == [0, 1, 2, 3]
    assert [event.event_id for event in events] == [
        "user-input:turn",
        "tool-start:call-a",
        "tool-start:call-b",
        "tool-result:call-a",
    ]


def test_build_root_turns_spawning_calls_into_agent_nodes() -> None:
    root = _root()

    agent = _find(root, "toolu_agent1")
    assert agent.kind is NodeKind.AGENT
    assert agent.agent_uuid == "aaa"
    assert agent.topic == "Investigate tests"
    assert agent.model == "claude-haiku-4-5-20251001"
    assert agent.prompt == "Look at the tests"
    assert agent.result == "Tests use fixtures."
    assert [c.node_id for c in agent.children] == ["toolu_grep1", "toolu_agent2"]
    assert agent.llm_call_count == Metric.exact(4)
    assert agent.llm_calls[0].cost.value == pytest.approx(0.000475)
    grep = _find(root, "toolu_grep1")
    child_start = next(event for event in agent.execution_events if event.subject_node_id == grep.node_id)
    assert child_start.source_stream_id == "claude-code:agent-aaa"


def test_build_root_nests_subagents_at_any_depth() -> None:
    nested = _find(_root(), "toolu_agent2")

    assert nested.kind is NodeKind.AGENT
    assert nested.agent_uuid == "bbb"
    assert nested.topic == "Check fixtures"
    assert nested.model == "claude-haiku-4-5-20251001"
    assert [c.node_id for c in nested.children] == ["toolu_poll1"]
    assert nested.end == Metric.exact(_T0 + 50_000)


def test_build_root_extends_a_resumed_subagent_to_its_last_activity() -> None:
    agent = _find(_root(), "toolu_agent1")

    assert agent.start == Metric.exact(_T0 + 3000)
    assert agent.end == Metric.exact(_T0 + 700_000)
    assert agent.duration == Metric.exact(697_000)


def test_send_message_links_prose_resume_result_to_exact_agent_id() -> None:
    main = Transcript(
        prompts=[Prompt(uuid="p", start_ms=0, text="continue")],
        tool_uses=[
            ToolUse(
                tool_use_id="send",
                name="SendMessage",
                input={"target": "lead", "message": "Continue now"},
                start_ms=10,
            )
        ],
        tool_results={"send": ToolResult(end_ms=20, is_error=False, text="Resuming agent abc")},
    )
    child = Transcript(messages=[AssistantMessage(message_id="m", start_ms=30, model="claude-sonnet-5")])
    subagent = Subagent(
        meta=SubagentMeta(agent_id="abc", tool_use_id=None, agent_type=None, description="lead", model=None),
        transcript=child,
    )

    root = build_root(main, [subagent], PriceTable.load(), "session")
    send = _find(root, "send")
    agent = _find(root, "agent-abc")

    assert send.tool is not None
    assert send.tool.is_resume
    assert send.tool.target_agent_id == "abc"
    assert send.tool.linked_agent_node_id == agent.node_id
    assert agent.resume_times == [Metric.exact(10)]
    resume_event = next(event for event in agent.execution_events if event.kind == "resume")
    assert resume_event.start == agent.resume_times[0]
    assert resume_event.event_id is None
    assert resume_event.source_order is None
    assert resume_event.execution_start.value is None
    assert resume_event.execution_end.value is None
    assert resume_event.links == []


def test_send_message_reads_actual_to_and_resumed_agent_id_fields() -> None:
    main = Transcript(
        prompts=[Prompt(uuid="p", start_ms=0, text="continue")],
        tool_uses=[
            ToolUse(
                tool_use_id="send",
                name="SendMessage",
                input={"to": "abc", "recipient": "abc", "content": "Continue now"},
                start_ms=10,
            )
        ],
        tool_results={
            "send": ToolResult(
                end_ms=20,
                is_error=False,
                text='{"success":true,"message":"Resuming agent abc","resumedAgentId":"abc"}',
            )
        },
    )
    child = Transcript(messages=[AssistantMessage(message_id="m", start_ms=30, model="claude-sonnet-5")])
    subagent = Subagent(
        meta=SubagentMeta(agent_id="abc", tool_use_id=None, agent_type=None, description="lead", model=None),
        transcript=child,
    )

    root = build_root(main, [subagent], PriceTable.load(), "session")
    send = _find(root, "send")
    agent = _find(root, "agent-abc")

    assert send.topic == "SendMessage to abc: Continue now"
    assert send.tool is not None
    assert send.tool.is_resume
    assert send.tool.target_agent_id == "abc"
    assert send.tool.linked_agent_node_id == agent.node_id
    assert agent.resume_times == [Metric.exact(10)]


def test_send_message_links_explicit_resume_by_exact_harness_agent_id() -> None:
    main = Transcript(
        prompts=[Prompt(uuid="turn", start_ms=0, text="delegate")],
        tool_uses=[
            ToolUse(tool_use_id="spawn", name="Agent", input={}, start_ms=1),
            ToolUse(
                tool_use_id="message",
                name="SendMessage",
                input={"target": "agent-42", "message": "Continue the review\nprivate follow-up"},
                start_ms=10,
            ),
        ],
        tool_results={
            "message": ToolResult(end_ms=11, is_error=False, text='{"resumed": true}'),
        },
    )
    subagent = Subagent(
        meta=SubagentMeta(agent_id="agent-42", tool_use_id="spawn", agent_type=None, description="review", model=None),
        transcript=Transcript(),
    )

    root = build_root(main, [subagent], PriceTable.load(), "t")
    message = _find(root, "message")
    agent = _find(root, "spawn")

    assert message.topic == "SendMessage to agent-42: Continue the review"
    assert message.tool is not None
    assert message.tool.target_agent_id == "agent-42"
    assert message.tool.is_resume
    assert message.tool.linked_agent_node_id == "spawn"
    assert agent.resume_times == [Metric.exact(10)]


@pytest.mark.parametrize("result", ['{"resumed": false}', "Message sent successfully", '{"resumed": true}'])
def test_send_message_does_not_link_without_a_unique_explicit_resume(result: str) -> None:
    main = Transcript(
        prompts=[Prompt(uuid="turn", start_ms=0, text="delegate")],
        tool_uses=[ToolUse(tool_use_id="message", name="SendMessage", input={"target": "agent-42"}, start_ms=10)],
        tool_results={"message": ToolResult(end_ms=11, is_error=False, text=result)},
    )
    subagents = (
        []
        if result == '{"resumed": true}'
        else [
            Subagent(
                meta=SubagentMeta(agent_id="agent-42", tool_use_id=None, agent_type=None, description=None, model=None),
                transcript=Transcript(),
            ),
            Subagent(
                meta=SubagentMeta(agent_id="agent-42", tool_use_id=None, agent_type=None, description=None, model=None),
                transcript=Transcript(),
            ),
        ]
    )

    root = build_root(main, subagents, PriceTable.load(), "t")
    message = _find(root, "message")

    assert message.tool is not None
    assert message.tool.linked_agent_node_id is None
    assert all(event.kind != "resume" for node in iter_nodes(root) for event in node.execution_events)


def test_build_root_keeps_an_async_subagent_open() -> None:
    tool_use_id = "agent-call"
    main = Transcript(
        prompts=[Prompt(uuid="turn", start_ms=0, text="delegate")],
        tool_uses=[ToolUse(tool_use_id=tool_use_id, name="Agent", input={}, start_ms=1)],
        tool_results={tool_use_id: ToolResult(end_ms=2, is_error=False, text="Async agent launched successfully.")},
    )
    child = Transcript(
        messages=[AssistantMessage(message_id="child-message", start_ms=3, model="claude-sonnet-5")],
        tool_uses=[ToolUse(tool_use_id="child-tool", name="Bash", input={}, start_ms=4)],
    )
    subagent = Subagent(
        meta=SubagentMeta(agent_id="child", tool_use_id=tool_use_id, agent_type=None, description="child", model=None),
        transcript=child,
    )

    root = build_root(main, [subagent], PriceTable.load(), "t")
    roll_up(root)
    agent = _find(root, tool_use_id)

    assert agent.end == Metric.estimated(3)
    assert agent.duration == Metric.estimated(2)


def test_build_root_places_an_orphan_subagent_by_start_time() -> None:
    orphan = _find(_root(), "agent-ccc")

    assert orphan.kind is NodeKind.AGENT
    assert orphan.topic == "ccc"
    assert orphan.start == Metric.exact(_T0 + 650_000)
    assert orphan.llm_call_count == Metric.exact(1)


def test_build_root_estimates_user_wait_from_ask_user_question() -> None:
    first, second = _root().children

    assert first.user_wait == Metric.estimated(30_000)
    assert second.user_wait == Metric.estimated(0)


def test_build_root_makes_one_synthetic_turn_without_prompts() -> None:
    transcript = load_transcript(_PROJECT / "11111111-1111-4111-8111-111111111111" / "subagents" / "agent-bbb.jsonl")
    transcript.prompts = []

    root = build_root(transcript, [], PriceTable.load(), "t")

    (turn,) = root.children
    assert turn.node_id == "turn-1"
    assert turn.start == Metric.exact(_T0 + 7000)


def test_build_root_of_an_empty_transcript_has_no_turns() -> None:
    assert build_root(Transcript(), [], PriceTable.load(), "t").children == []


def test_build_root_puts_compactions_on_the_turn_they_occur_in() -> None:
    main = load_transcript(_PROJECT / "11111111-1111-4111-8111-111111111111.jsonl")

    root = build_root(main, [], PriceTable.load(), "t")

    first, second = root.children
    assert first.compactions == [Metric.exact(main.compactions_ms[0])]
    assert second.compactions == []


def test_build_root_keeps_synthetic_messages_out_of_the_context() -> None:
    main = Transcript(
        prompts=[Prompt(uuid="u", start_ms=0, text="hi")],
        messages=[
            AssistantMessage(message_id="m1", start_ms=1, model="claude-sonnet-5", usage={"input_tokens": 10}),
            AssistantMessage(message_id="m2", start_ms=2, model="<synthetic>", usage={"input_tokens": 0}),
        ],
    )

    root = build_root(main, [], PriceTable.load(), "t")

    assert [call.in_context for call in root.children[0].llm_calls] == [True, False]
