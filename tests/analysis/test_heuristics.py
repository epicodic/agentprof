# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic

from agentprof.analysis.heuristics import find_findings
from agentprof.model import (
    CostMetric,
    Finding,
    LlmCall,
    Metric,
    Node,
    NodeKind,
    Provenance,
    Tokens,
    ToolCategory,
    ToolInfo,
)


def _tool(
    category: ToolCategory,
    node_id: str,
    start_ms: int,
    end_ms: int,
    *,
    success: bool = True,
    path: str | None = None,
    line_range: tuple[int, int] | None = None,
    command: str | None = None,
) -> Node:
    return Node(
        node_id=node_id,
        kind=NodeKind.TOOL,
        topic=category.value,
        tool=ToolInfo(native_id=category.value, category=category, path=path, line_range=line_range, command=command),
        start=Metric.exact(start_ms),
        end=Metric.exact(end_ms),
        duration=Metric.exact(end_ms - start_ms),
        success=success,
    )


def _agent(node_id: str, children: list[Node], topic: str = "worker") -> Node:
    return Node(node_id=node_id, kind=NodeKind.AGENT, topic=topic, children=children)


def _hits(findings: list[Finding], heuristic_id: str) -> list[str]:
    return [finding.node_id for finding in findings if finding.heuristic_id == heuristic_id]


def _read(node_id: str, start_ms: int, path: str | None, line_range: tuple[int, int] | None = None) -> Node:
    return _tool(ToolCategory.READ, node_id, start_ms, start_ms + 10, path=path, line_range=line_range)


def test_w1_flags_the_same_file_read_three_times() -> None:
    agent = _agent("a1", [_read("t1", 0, "foo.py"), _read("t2", 10, "foo.py"), _read("t3", 20, "foo.py")])

    assert _hits(find_findings(agent), "W1") == ["a1"]


def test_w1_flags_overlapping_line_ranges() -> None:
    agent = _agent(
        "a1",
        [
            _read("t1", 0, "foo.py", (1, 50)),
            _read("t2", 10, "foo.py", (10, 20)),
            _read("t3", 20, "foo.py", (40, 60)),
        ],
    )

    assert _hits(find_findings(agent), "W1") == ["a1"]


def test_w1_does_not_flag_disjoint_line_ranges() -> None:
    agent = _agent(
        "a1",
        [
            _read("t1", 0, "foo.py", (1, 10)),
            _read("t2", 10, "foo.py", (11, 20)),
            _read("t3", 20, "foo.py", (21, 30)),
        ],
    )

    assert _hits(find_findings(agent), "W1") == []


def test_w1_does_not_flag_two_reads_of_the_same_file() -> None:
    agent = _agent("a1", [_read("t1", 0, "foo.py"), _read("t2", 10, "foo.py")])

    assert _hits(find_findings(agent), "W1") == []


def test_w1_does_not_group_reads_with_unknown_paths() -> None:
    agent = _agent("a1", [_read(f"t{i}", i * 10, None) for i in range(5)])

    assert _hits(find_findings(agent), "W1") == []


def test_w4_flags_the_same_shell_command_three_times() -> None:
    agent = _agent(
        "a1",
        [_tool(ToolCategory.SHELL, f"t{i}", i * 10, i * 10 + 5, command="pytest -x") for i in range(3)],
    )

    findings = find_findings(agent)

    assert any(f.heuristic_id == "W4" and "repeated" in f.message for f in findings)


def test_w4_does_not_group_commands_with_unknown_arguments() -> None:
    agent = _agent("a1", [_tool(ToolCategory.SHELL, f"t{i}", i * 10, i * 10 + 5) for i in range(5)])

    findings = find_findings(agent)

    assert not any(f.heuristic_id == "W4" and "repeated" in f.message for f in findings)


def test_w4_flags_a_high_tool_failure_rate() -> None:
    agent = _agent(
        "a1",
        [_tool(ToolCategory.SHELL, f"t{i}", i * 10, i * 10 + 5, success=(i != 0)) for i in range(5)],
    )

    findings = find_findings(agent)

    assert any(f.heuristic_id == "W4" and "failure" in f.message for f in findings)


def test_w5_flags_five_consecutive_polling_calls() -> None:
    agent = _agent("a1", [_tool(ToolCategory.SHELL_POLL, f"t{i}", i * 10, i * 10 + 1) for i in range(5)])

    assert _hits(find_findings(agent), "W5") == ["a1"]


def test_w5_does_not_flag_polling_interleaved_with_other_work() -> None:
    agent = _agent(
        "a1",
        [
            _tool(ToolCategory.SHELL_POLL, "t1", 0, 1),
            _tool(ToolCategory.SHELL_POLL, "t2", 1, 2),
            _tool(ToolCategory.READ, "t3", 2, 3),
            _tool(ToolCategory.SHELL_POLL, "t4", 3, 4),
            _tool(ToolCategory.SHELL_POLL, "t5", 4, 5),
        ],
    )

    assert _hits(find_findings(agent), "W5") == []


def test_idle_gaps_do_not_emit_findings() -> None:
    agent = _agent(
        "a1",
        [_tool(ToolCategory.READ, "t1", 0, 1000), _tool(ToolCategory.READ, "t2", 131_000, 131_500)],
    )

    assert _hits(find_findings(agent), "W6") == []


def _costly_siblings(costs: list[CostMetric]) -> Node:
    siblings = [
        Node(node_id=f"a{i}", kind=NodeKind.AGENT, topic=f"task {i}", cost_total=c) for i, c in enumerate(costs)
    ]
    return Node(node_id="root", kind=NodeKind.TURN, topic="root", children=siblings)


def _credits(value: float) -> CostMetric:
    return CostMetric(value=value, unit="credits", provenance=Provenance.EXACT)


def test_w7_flags_a_cost_outlier_among_four_or_more_siblings() -> None:
    root = _costly_siblings([_credits(10.0)] * 4 + [_credits(500.0)])

    assert _hits(find_findings(root), "W7") == ["a4"]


def test_w7_requires_at_least_four_siblings() -> None:
    root = _costly_siblings([_credits(10.0), _credits(500.0)])

    assert _hits(find_findings(root), "W7") == []


def test_w7_skips_siblings_with_mixed_units() -> None:
    usd = CostMetric(value=500.0, unit="USD", provenance=Provenance.ESTIMATED)
    root = _costly_siblings([_credits(10.0)] * 4 + [usd])

    assert _hits(find_findings(root), "W7") == []


def test_w2_flags_a_child_rereading_a_file_its_parent_just_read() -> None:
    child = _agent("child", [_read("c1", 60_000, "foo.py")])
    parent = _agent("parent", [_read("p1", 0, "foo.py"), child])

    assert _hits(find_findings(parent), "W2") == ["child"]


def test_w2_does_not_flag_a_reread_after_the_window() -> None:
    child = _agent("child", [_read("c1", 11 * 60_000, "foo.py")])
    parent = _agent("parent", [_read("p1", 0, "foo.py"), child])

    assert _hits(find_findings(parent), "W2") == []


def test_w2_does_not_flag_a_different_file() -> None:
    child = _agent("child", [_read("c1", 60_000, "bar.py")])
    parent = _agent("parent", [_read("p1", 0, "foo.py"), child])

    assert _hits(find_findings(parent), "W2") == []


def test_w3_flags_a_sibling_with_a_similar_topic() -> None:
    parent = _agent(
        "parent",
        [
            _agent("first", [], topic="Fix failing test in parser module"),
            _agent("second", [], topic="Fix failing test in parser module again"),
        ],
    )

    assert _hits(find_findings(parent), "W3") == ["second"]


def test_w3_does_not_flag_unrelated_siblings() -> None:
    parent = _agent("parent", [_agent("first", [], topic="Write docs"), _agent("second", [], topic="Refactor parser")])

    assert _hits(find_findings(parent), "W3") == []


def test_w3_does_not_flag_siblings_that_differ_in_their_numbers() -> None:
    parent = _agent(
        "parent",
        [
            _agent("first", [], topic="Code quality review for Task 2"),
            _agent("second", [], topic="Code quality review for Task 3"),
        ],
    )

    assert _hits(find_findings(parent), "W3") == []


def test_w3_still_flags_a_retry_with_the_same_number() -> None:
    parent = _agent(
        "parent",
        [
            _agent("first", [], topic="Implement Task 2"),
            _agent("second", [], topic="Implement Task 2 again"),
        ],
    )

    assert _hits(find_findings(parent), "W3") == ["second"]


def _call(uncached: int, cached: int) -> LlmCall:
    return LlmCall(
        start=Metric.exact(0),
        tokens=Tokens(input=Metric.exact(uncached), output=Metric.exact(100), cache_read=Metric.exact(cached)),
    )


def test_w8_flags_a_large_mean_uncached_prompt() -> None:
    agent = _agent("a1", [])
    agent.llm_calls = [_call(150_000, 0), _call(120_000, 140_000)]

    findings = find_findings(agent)

    assert any(f.heuristic_id == "W8" and "mean uncached prompt" in f.message for f in findings)


def test_w8_does_not_flag_a_large_well_cached_prompt() -> None:
    agent = _agent("a1", [])
    agent.llm_calls = [_call(1_000, 300_000)] * 3

    assert _hits(find_findings(agent), "W8") == []


def test_w8_flags_a_low_cache_hit_ratio() -> None:
    agent = _agent("a1", [])
    agent.llm_calls = [_call(10_000, 1_000)] * 3

    findings = find_findings(agent)

    assert any(f.heuristic_id == "W8" and "cache hit ratio" in f.message for f in findings)


def test_w8_does_not_flag_a_well_cached_moderate_prompt() -> None:
    agent = _agent("a1", [])
    agent.llm_calls = [_call(1_000, 50_000)] * 3

    assert _hits(find_findings(agent), "W8") == []


def test_w8_does_not_judge_the_cache_ratio_of_fewer_than_three_calls() -> None:
    agent = _agent("a1", [])
    agent.llm_calls = [_call(10_000, 0)] * 2

    assert _hits(find_findings(agent), "W8") == []


def test_w8_ignores_calls_without_token_counts() -> None:
    agent = _agent("a1", [])
    agent.llm_calls = [LlmCall(start=Metric.exact(0))] * 3

    assert _hits(find_findings(agent), "W8") == []
