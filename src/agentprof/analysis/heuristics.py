# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Waste heuristics over the neutral model. Findings are hints, not verdicts.

Heuristics only look at tool categories and normalised arguments, never at native tool ids.
"""

import re
from collections.abc import Callable
from typing import NamedTuple

from agentprof.model import Finding, LlmCall, Node, NodeKind, ToolCategory, iter_nodes

_MIN_REPEATED_READS = 3
_MIN_REPEATED_COMMANDS = 3
_MAX_FAILURE_RATE = 0.2
_MIN_POLLING_STREAK = 5
_MIN_SIBLINGS_FOR_COST_OUTLIER = 4
_COST_OUTLIER_PERCENTILE = 0.9
_REACQUIRE_WINDOW_MS = 10 * 60 * 1000
_MIN_TOPIC_SIMILARITY = 0.6
_MAX_MEAN_UNCACHED_PROMPT_TOKENS = 100_000
_MIN_CACHE_HIT_RATIO = 0.5
_MIN_CALLS_FOR_CACHE_RATIO = 3
_WORD = re.compile(r"\w+")
_NUMBER = re.compile(r"\d+")
_AGENT_KINDS = (NodeKind.TURN, NodeKind.AGENT)


class _Read(NamedTuple):
    path: str
    line_range: tuple[int, int] | None
    node: Node


def _reads(agent: Node) -> list[_Read]:
    reads: list[_Read] = []
    for child in agent.children:
        tool = child.tool
        if tool is None or tool.category is not ToolCategory.READ:
            continue
        if (path := tool.path) is not None:
            reads.append(_Read(path=path, line_range=tool.line_range, node=child))
    return reads


def _is_category(node: Node, category: ToolCategory) -> bool:
    return node.tool is not None and node.tool.category is category


def _percentile(sorted_values: list[float], quantile: float) -> float:
    """Linear-interpolation percentile (numpy's default `linear` method)."""
    if len(sorted_values) == 1:
        return sorted_values[0]
    position = quantile * (len(sorted_values) - 1)
    lower_index = int(position)
    upper_index = min(lower_index + 1, len(sorted_values) - 1)
    fraction = position - lower_index
    return sorted_values[lower_index] + (sorted_values[upper_index] - sorted_values[lower_index]) * fraction


def _overlaps(first: tuple[int, int] | None, second: tuple[int, int] | None) -> bool:
    """Unknown line ranges mean the whole file and overlap everything."""
    if first is None or second is None:
        return True
    return first[0] <= second[1] and second[0] <= first[1]


def _check_repeated_reads(agent: Node) -> list[Finding]:
    """W1: the same file read with overlapping line ranges at least three times within one agent."""
    ranges_by_path: dict[str, list[tuple[int, int] | None]] = {}
    for read in _reads(agent):
        ranges_by_path.setdefault(read.path, []).append(read.line_range)
    findings: list[Finding] = []
    for path, ranges in ranges_by_path.items():
        count = max(sum(1 for other in ranges if _overlaps(current, other)) for current in ranges)
        if count >= _MIN_REPEATED_READS:
            findings.append(
                Finding(
                    heuristic_id="W1",
                    node_id=agent.node_id,
                    severity="low",
                    message=f"{path!r} read {count} times with overlapping line ranges",
                    evidence={"path": path, "count": count},
                )
            )
    return findings


def _check_repeated_or_failed_commands(agent: Node) -> list[Finding]:
    """W4: the same shell command at least three times, or a tool failure rate of 20 % or more."""
    findings: list[Finding] = []
    counts: dict[str, int] = {}
    for child in agent.children:
        tool = child.tool
        if tool is None or tool.category is not ToolCategory.SHELL:
            continue
        if (command := tool.command) is not None:
            counts[command] = counts.get(command, 0) + 1
    for command, count in counts.items():
        if count >= _MIN_REPEATED_COMMANDS:
            findings.append(
                Finding(
                    heuristic_id="W4",
                    node_id=agent.node_id,
                    severity="medium",
                    message=f"repeated command run {count} times: {command!r}",
                    evidence={"command": command, "count": count},
                )
            )

    tool_children = [child for child in agent.children if child.kind is NodeKind.TOOL]
    if tool_children:
        failures = sum(1 for child in tool_children if child.success is False)
        rate = failures / len(tool_children)
        if rate >= _MAX_FAILURE_RATE:
            findings.append(
                Finding(
                    heuristic_id="W4",
                    node_id=agent.node_id,
                    severity="medium",
                    message=f"tool failure rate {rate:.0%} ({failures}/{len(tool_children)})",
                    evidence={"failure_rate": rate},
                )
            )
    return findings


def _check_polling_loops(agent: Node) -> list[Finding]:
    """W5: at least five consecutive shell polling calls without other tool calls."""
    streak = 0
    for child in agent.children:
        if not _is_category(child, ToolCategory.SHELL_POLL):
            streak = 0
            continue
        streak += 1
        if streak == _MIN_POLLING_STREAK:
            return [
                Finding(
                    heuristic_id="W5",
                    node_id=agent.node_id,
                    severity="low",
                    message=f"{streak} consecutive polling calls",
                    evidence={"streak": streak},
                )
            ]
    return []


def _check_cost_outliers(parent: Node) -> list[Finding]:
    """W7: an agent above the 90th percentile of its siblings' cost (at least four siblings, one unit)."""
    siblings = [c for c in parent.children if c.kind is NodeKind.AGENT and c.cost_total.value is not None]
    if len(siblings) < _MIN_SIBLINGS_FOR_COST_OUTLIER:
        return []
    units = {sibling.cost_total.unit for sibling in siblings}
    if len(units) != 1:
        return []
    unit = units.pop()
    threshold = _percentile(sorted(float(s.cost_total.value or 0.0) for s in siblings), _COST_OUTLIER_PERCENTILE)
    findings: list[Finding] = []
    for sibling in siblings:
        cost = float(sibling.cost_total.value or 0.0)
        if cost > threshold:
            findings.append(
                Finding(
                    heuristic_id="W7",
                    node_id=sibling.node_id,
                    severity="medium",
                    message=f"cost {cost:.1f} {unit} above the 90th percentile of its siblings",
                    evidence={"cost": cost, "unit": unit, "threshold": threshold},
                )
            )
    return findings


def _check_reacquired_context(parent: Node) -> list[Finding]:
    """W2: a child agent reads a file its parent read within the preceding 10 minutes."""
    parent_read_ends = [
        (read.path, read.node.end.number()) for read in _reads(parent) if read.node.end.value is not None
    ]
    findings: list[Finding] = []
    for child_agent in parent.children:
        if child_agent.kind is not NodeKind.AGENT:
            continue
        flagged: set[str] = set()
        for read in _reads(child_agent):
            if read.path in flagged or read.node.start.value is None:
                continue
            start = read.node.start.number()
            if any(path == read.path and 0 <= start - end <= _REACQUIRE_WINDOW_MS for path, end in parent_read_ends):
                flagged.add(read.path)
                findings.append(
                    Finding(
                        heuristic_id="W2",
                        node_id=child_agent.node_id,
                        severity="low",
                        message=f"{read.path!r} was already read by the parent agent",
                        evidence={"path": read.path},
                    )
                )
    return findings


def _words(topic: str) -> set[str]:
    return set(_WORD.findall(topic.lower()))


def _numbers(topic: str) -> set[str]:
    return set(_NUMBER.findall(topic))


def _check_retry_chains(parent: Node) -> list[Finding]:
    """W3: sibling agents with a word-set Jaccard topic similarity of at least 0.6, unless their numbers differ."""
    agents = [child for child in parent.children if child.kind is NodeKind.AGENT]
    findings: list[Finding] = []
    for index, later in enumerate(agents):
        later_words = _words(later.topic)
        for earlier in agents[:index]:
            earlier_words = _words(earlier.topic)
            later_numbers, earlier_numbers = _numbers(later.topic), _numbers(earlier.topic)
            if later_numbers and earlier_numbers and later_numbers != earlier_numbers:
                continue  # numbered variants of one task ("Task 2", "Task 3") are not retries
            union = later_words | earlier_words
            if not union:
                continue
            similarity = len(later_words & earlier_words) / len(union)
            if similarity >= _MIN_TOPIC_SIMILARITY:
                findings.append(
                    Finding(
                        heuristic_id="W3",
                        node_id=later.node_id,
                        severity="medium",
                        message=f"topic {similarity:.0%} similar to earlier sibling {earlier.node_id!r}",
                        evidence={"earlier": earlier.node_id, "similarity": similarity},
                    )
                )
                break
    return findings


def _prompt_and_cached(call: LlmCall) -> tuple[float, float] | None:
    """Prompt size and cached part of one call, or `None` if the counts are unavailable."""
    tokens = call.tokens
    if (uncached := tokens.input.value) is None or (cached := tokens.cache_read.value) is None:
        return None
    cache_write = tokens.cache_write.value or 0
    return float(uncached + cached + cache_write), float(cached)


def _check_context_bloat(agent: Node) -> list[Finding]:
    """W8: large mean uncached prompt per LLM call, or a low cache hit ratio.

    Only the uncached part (`input + cache_write`) counts towards the size rule: cached tokens cost a fraction
    of that, so a large but well-cached context is not waste.
    """
    measured = [pair for call in agent.llm_calls if (pair := _prompt_and_cached(call)) is not None]
    if not measured:
        return []
    findings: list[Finding] = []
    total_prompt = sum(prompt for prompt, _ in measured)
    mean_uncached = sum(prompt - cached for prompt, cached in measured) / len(measured)
    if mean_uncached > _MAX_MEAN_UNCACHED_PROMPT_TOKENS:
        findings.append(
            Finding(
                heuristic_id="W8",
                node_id=agent.node_id,
                severity="medium",
                message=f"mean uncached prompt of {mean_uncached:,.0f} tokens per LLM call",
                evidence={"mean_uncached_prompt_tokens": mean_uncached},
            )
        )
    if len(measured) >= _MIN_CALLS_FOR_CACHE_RATIO and total_prompt > 0:
        ratio = sum(cached for _, cached in measured) / total_prompt
        if ratio < _MIN_CACHE_HIT_RATIO:
            findings.append(
                Finding(
                    heuristic_id="W8",
                    node_id=agent.node_id,
                    severity="low",
                    message=f"cache hit ratio {ratio:.0%}",
                    evidence={"cache_hit_ratio": ratio},
                )
            )
    return findings


_CHECKS: tuple[Callable[[Node], list[Finding]], ...] = (
    _check_repeated_reads,
    _check_reacquired_context,
    _check_retry_chains,
    _check_repeated_or_failed_commands,
    _check_polling_loops,
    _check_cost_outliers,
    _check_context_bloat,
)


def find_findings(root: Node) -> list[Finding]:
    """Run all heuristics on every turn and agent node of the tree rooted at `root`."""
    return [
        finding
        for node in iter_nodes(root)
        if node.kind in _AGENT_KINDS
        for check in _CHECKS
        for finding in check(node)
    ]
