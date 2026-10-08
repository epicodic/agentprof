// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { makeCall, makeExecutionEvent, makeNode, makeTool, metric } from "../test/factories";
import { compareObservedItems, observedItems, observeWorkflow } from "./workflowState";

describe("workflow observations", () => {
  it("does not complete an agent because its tool failed or time passed", () => {
    const agent = makeNode({
      node_id: "worker",
      kind: "agent",
      activity: "running",
      execution_events: [makeExecutionEvent({ kind: "tool_result", success: false, start: metric(100) })],
    });
    expect(observeWorkflow([agent])).toMatchObject({ status: "running", evidence: "inferred" });
  });

  it("uses source order to distinguish completion from a subsequent resume", () => {
    const agent = makeNode({
      node_id: "worker",
      kind: "agent",
      execution_events: [
        makeExecutionEvent({
          kind: "completion",
          event_id: "done",
          source_stream_id: "stream",
          source_order: 2,
        }),
      ],
    });
    expect(observeWorkflow([agent])).toMatchObject({ status: "completed", evidence: "recorded" });
    agent.execution_events?.push(makeExecutionEvent({ kind: "resume", source_stream_id: "stream", source_order: 3 }));
    expect(observeWorkflow([agent])).toMatchObject({
      status: "unknown",
      completionRecorded: true,
      taskOwnerId: "worker",
    });
  });

  it("keeps completion evidence without guessing across untimed streams", () => {
    const agent = makeNode({
      node_id: "worker",
      kind: "agent",
      llm_calls: [makeCall({ source_stream_id: "a", source_order: 9 })],
      execution_events: [makeExecutionEvent({ kind: "completion", source_stream_id: "b", source_order: 2 })],
    });
    expect(observeWorkflow([agent])).toMatchObject({
      status: "unknown",
      completionRecorded: true,
      latest: null,
      taskOwnerId: null,
    });
  });

  it("lets finite nonnegative timestamps order observations across streams", () => {
    const items = observedItems([
      makeNode({
        node_id: "a",
        kind: "agent",
        execution_events: [makeExecutionEvent({ start: metric(10), source_stream_id: "one" })],
      }),
      makeNode({
        node_id: "b",
        kind: "agent",
        execution_events: [makeExecutionEvent({ start: metric(20), source_stream_id: "two" })],
      }),
    ]);
    expect(compareObservedItems(items[0], items[1])).toBe(-1);
  });

  it("does not treat child completion as the owner's completion", () => {
    const agent = makeNode({
      node_id: "worker",
      kind: "agent",
      activity: "running",
      execution_events: [makeExecutionEvent({ kind: "child_completion", success: true, start: metric(100) })],
    });
    expect(observeWorkflow([agent])).toMatchObject({ status: "running", completionRecorded: false });
  });

  it("does not treat another owner's completion subject as its own terminal event", () => {
    const agent = makeNode({
      node_id: "worker",
      kind: "agent",
      activity: "waiting",
      execution_events: [makeExecutionEvent({ kind: "completion", subject_node_id: "someone-else", success: true })],
    });
    expect(observeWorkflow([agent])).toMatchObject({ status: "waiting", completionRecorded: false });
  });

  it("accepts absent, empty, and self completion subjects as own completion", () => {
    for (const subject of [undefined, "", "worker"]) {
      const agent = makeNode({
        node_id: "worker",
        kind: "agent",
        execution_events: [makeExecutionEvent({ kind: "completion", subject_node_id: subject, success: true })],
      });
      expect(observeWorkflow([agent])).toMatchObject({
        status: "completed",
        evidence: "recorded",
        completionRecorded: true,
      });
    }
  });

  it("does not infer terminal state from node success, end time, or inactive status", () => {
    const agent = makeNode({
      node_id: "worker",
      kind: "agent",
      active: false,
      activity: null,
      success: false,
      end: metric(100),
    });
    expect(observeWorkflow([agent])).toMatchObject({ status: "unknown", evidence: "unavailable" });
  });

  it("uses all maximal own completions to distinguish failed, successful, and mixed outcomes", () => {
    const makeOwner = (success: boolean | null, order: number) =>
      makeNode({
        node_id: `owner-${order}`,
        kind: "agent",
        execution_events: [
          makeExecutionEvent({
            kind: "completion",
            success,
            source_stream_id: "same",
            source_order: order,
          }),
        ],
      });
    expect(observeWorkflow([makeOwner(false, 2), makeOwner(false, 1)]).status).toBe("failed");
    expect(observeWorkflow([makeOwner(null, 2), makeOwner(true, 1)]).status).toBe("completed");
    const failed = makeNode({
      node_id: "failed",
      kind: "agent",
      execution_events: [
        makeExecutionEvent({
          kind: "completion",
          success: false,
          source_stream_id: "failed-stream",
        }),
      ],
    });
    const succeeded = makeNode({
      node_id: "succeeded",
      kind: "agent",
      execution_events: [
        makeExecutionEvent({
          kind: "completion",
          success: true,
          source_stream_id: "success-stream",
        }),
      ],
    });
    expect(observeWorkflow([failed, succeeded])).toMatchObject({ status: "unknown", evidence: "unavailable" });
  });

  it("lets a later call supersede a completion without treating the call as terminal", () => {
    const owner = makeNode({
      node_id: "worker",
      kind: "agent",
      activity: "running",
      execution_events: [makeExecutionEvent({ kind: "completion", source_stream_id: "s", source_order: 1 })],
      llm_calls: [makeCall({ source_stream_id: "s", source_order: 2 })],
    });
    expect(observeWorkflow([owner])).toMatchObject({
      status: "running",
      completionRecorded: true,
      latest: { entry: { kind: "call" } },
    });
  });

  it("keeps tied timestamps ambiguous and does not use input order", () => {
    const first = makeNode({
      node_id: "first",
      kind: "agent",
      execution_events: [makeExecutionEvent({ start: metric(30) })],
    });
    const second = makeNode({
      node_id: "second",
      kind: "agent",
      execution_events: [makeExecutionEvent({ start: metric(30) })],
    });
    for (const nodes of [
      [first, second],
      [second, first],
    ]) {
      expect(observeWorkflow(nodes)).toMatchObject({ latest: null, taskOwnerId: null, status: "unknown" });
    }
  });

  it("selects a unique latest logical owner across resumed owner nodes", () => {
    const old = makeNode({
      node_id: "old",
      kind: "agent",
      agent_id: 4,
      activity: "completed",
      execution_events: [makeExecutionEvent({ start: metric(10) })],
    });
    const resumed = makeNode({
      node_id: "resumed",
      kind: "agent",
      agent_id: 4,
      activity: "waiting",
      execution_events: [makeExecutionEvent({ start: metric(20) })],
    });
    expect(observeWorkflow([old, resumed])).toMatchObject({
      status: "waiting",
      taskOwnerId: "resumed",
      latest: { ownerId: "resumed" },
    });
  });

  it("filters tool nodes and leaves empty observations without an invented latest owner", () => {
    const tool = makeTool("tool", "Read", { execution_events: [makeExecutionEvent({ start: metric(20) })] });
    const idle = makeNode({ node_id: "idle", kind: "agent", activity: "running" });
    expect(observedItems([tool])).toEqual([]);
    expect(observeWorkflow([idle])).toMatchObject({
      status: "running",
      latest: null,
      latestTimedAtMs: null,
      taskOwnerId: null,
    });
    expect(observeWorkflow([])).toMatchObject({
      status: "unknown",
      evidence: "unavailable",
      latest: null,
      taskOwnerId: null,
    });
    expect(observeWorkflow([idle, makeNode({ node_id: "other", kind: "agent", activity: "waiting" })])).toMatchObject({
      status: "unknown",
      latest: null,
      taskOwnerId: null,
    });
  });

  it("is stable under permutations of incomparable observations", () => {
    const a = makeNode({ node_id: "a", kind: "agent", activity: "running", execution_events: [makeExecutionEvent()] });
    const b = makeNode({ node_id: "b", kind: "agent", activity: "waiting", execution_events: [makeExecutionEvent()] });
    expect(observeWorkflow([a, b])).toMatchObject({ status: "unknown", latest: null, taskOwnerId: null });
    expect(observeWorkflow([b, a])).toMatchObject({ status: "unknown", latest: null, taskOwnerId: null });
  });

  it("uses source evidence instead of source array order and leaves source arrays unchanged", () => {
    const owner = makeNode({
      node_id: "worker",
      kind: "agent",
      activity: "running",
      execution_events: [
        makeExecutionEvent({ kind: "completion", source_stream_id: "stream", source_order: 2 }),
        makeExecutionEvent({ kind: "resume", source_stream_id: "stream", source_order: 3 }),
      ],
      llm_calls: [
        makeCall({ source_stream_id: "stream", source_order: 1 }),
        makeCall({ source_stream_id: "stream", source_order: 4 }),
      ],
    });
    const eventsBefore = [...(owner.execution_events ?? [])];
    const callsBefore = [...owner.llm_calls];
    const forward = observeWorkflow([owner]);
    expect(owner.execution_events).toEqual(eventsBefore);
    expect(owner.llm_calls).toEqual(callsBefore);
    owner.execution_events?.reverse();
    owner.llm_calls.reverse();
    const reversed = observeWorkflow([owner]);

    expect(forward).toMatchObject({ status: "running", latest: { entry: { kind: "call" } } });
    expect(reversed).toMatchObject({
      status: forward.status,
      taskOwnerId: forward.taskOwnerId,
      latest: { entry: { kind: "call" } },
    });
    expect(owner.execution_events).toEqual(eventsBefore.toReversed());
    expect(owner.llm_calls).toEqual(callsBefore.toReversed());
  });

  it("normalizes blank streams and invalid or negative evidence values", () => {
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      execution_events: [
        makeExecutionEvent({ source_stream_id: "  ", source_order: Number.POSITIVE_INFINITY, start: metric(-1) }),
      ],
    });
    expect(observedItems([owner])[0]).toMatchObject({ streamId: null, sourceOrder: null, timeMs: null });
  });

  it("returns unknown when precedence comparisons form a cycle", () => {
    const owner = (nodeId: string, stream: string, order: number, time: number) =>
      makeNode({
        node_id: nodeId,
        kind: "agent",
        execution_events: [
          makeExecutionEvent({
            source_stream_id: stream,
            source_order: order,
            start: metric(time),
          }),
        ],
      });
    const cycle = [owner("a", "x", 1, 100), owner("b", "x", 2, 0), owner("c", "y", 1, 50)];
    expect(observeWorkflow(cycle)).toMatchObject({ status: "unknown", latest: null, taskOwnerId: null });
  });
});
