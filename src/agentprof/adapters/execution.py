# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Construct neutral source events for tool invocations and their results."""

from dataclasses import replace

from agentprof.model import EventCallLink, ExecutionEvent, Metric


def tool_execution_events(
    *,
    invocation_id: str | None,
    subject_node_id: str | None,
    start: Metric,
    end: Metric,
    result_recorded: bool,
    success: bool | None = None,
    delegation: bool = False,
    start_order: int | None = None,
    result_order: int | None = None,
    source_stream_id: str | None = None,
    request_id: str | None = None,
    next_id: str | None = None,
) -> list[ExecutionEvent]:
    """Create start and optional result events while keeping each event's links independent."""
    requested_links = (
        [EventCallLink(source_request_id=request_id, relation="requested_by", evidence="recorded")]
        if request_id is not None
        else []
    )
    events = [
        ExecutionEvent(
            kind="delegation" if delegation else "tool_start",
            event_id=f"tool-start:{invocation_id}" if invocation_id else None,
            start=start,
            source_order=start_order,
            links=[replace(link) for link in requested_links],
            subject_node_id=subject_node_id,
            source_stream_id=source_stream_id,
            execution_start=start,
            execution_end=end,
        )
    ]
    if result_recorded:
        result_links = list(requested_links)
        if next_id is not None:
            result_links.append(
                EventCallLink(source_request_id=next_id, relation="next_observed_call", evidence="observed_order")
            )
        events.append(
            ExecutionEvent(
                kind="tool_result",
                event_id=f"tool-result:{invocation_id}" if invocation_id else None,
                start=end,
                source_order=result_order,
                success=success,
                links=[replace(link) for link in result_links],
                subject_node_id=subject_node_id,
                source_stream_id=source_stream_id,
                execution_start=start,
                execution_end=end,
            )
        )
    return events
