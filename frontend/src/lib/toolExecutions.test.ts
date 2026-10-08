// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { makeExecutionEvent, makeNode, makeTool, metric } from "../test/factories";
import { toolExecutions } from "./toolExecutions";

describe("toolExecutions", () => {
  it("combines start and result once while retaining both records", () => {
    const tool = makeTool("read", "Read", { start: metric(20), end: metric(25), duration: metric(5) });
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      children: [tool],
      execution_events: [
        makeExecutionEvent({
          kind: "tool_start",
          event_id: "tool-start:invoke",
          subject_node_id: "read",
          start: metric(20),
        }),
        makeExecutionEvent({
          kind: "tool_result",
          event_id: "tool-result:invoke",
          subject_node_id: "read",
          start: metric(25),
          success: false,
        }),
      ],
    });
    const result = toolExecutions(owner, owner);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0].events).toHaveLength(2);
    expect(result.executions[0].startMs).toBe(20);
    expect(result.executions[0].resultMs).toBe(25);
    expect(result.executions[0].success).toBe(false);
    expect(result.byEventIndex.get(0)).toBe(result.byEventIndex.get(1));
  });

  it("pairs out-of-order records by the complete invocation suffix", () => {
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      execution_events: [
        makeExecutionEvent({ kind: "tool_start", event_id: "tool-start:a:b", start: metric(1) }),
        makeExecutionEvent({ kind: "tool_start", event_id: "tool-start:b", start: metric(2) }),
        makeExecutionEvent({ kind: "tool_result", event_id: "tool-result:b", start: metric(3) }),
        makeExecutionEvent({ kind: "tool_result", event_id: "tool-result:a:b", start: metric(4) }),
      ],
    });
    const result = toolExecutions(owner, owner);
    expect(result.executions.map((e) => [e.startMs, e.resultMs])).toEqual([
      [1, 4],
      [2, 3],
    ]);
    expect(result.executions.flatMap((e) => e.sourceEventIndexes).sort()).toEqual([0, 1, 2, 3]);
  });

  it("keeps unrelated delegation messages and emits unrepresented direct tools", () => {
    const tool = makeTool("tool", "Shell");
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      children: [tool],
      execution_events: [makeExecutionEvent({ kind: "delegation", event_id: "delegation:msg", start: metric(2) })],
    });
    const result = toolExecutions(owner, owner);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0].pairing).toBe("node-only");
    expect(result.byEventIndex.size).toBe(0);
  });

  it("retains start-only and result-only events as separate evidence rows", () => {
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      execution_events: [
        makeExecutionEvent({ kind: "tool_start", event_id: "tool-start:only-start", start: metric(8) }),
        makeExecutionEvent({
          kind: "tool_result",
          event_id: "tool-result:only-result",
          start: metric(9),
          success: true,
        }),
      ],
    });
    const { executions, byEventIndex } = toolExecutions(owner, owner);
    expect(executions).toHaveLength(2);
    expect(executions[0].startMs).toBe(8);
    expect(executions[0].resultRecorded).toBe(false);
    expect(executions[1].startMs).toBeNull();
    expect(executions[1].resultMs).toBe(9);
    expect(executions[1].resultRecorded).toBe(true);
    expect([...byEventIndex.keys()].sort()).toEqual([0, 1]);
  });

  it("does not fabricate a result-only start from rolled-up subject timing", () => {
    const tool = makeTool("tool", "Read", { start: metric(10), duration: metric(3) });
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      children: [tool],
      execution_events: [
        makeExecutionEvent({
          kind: "tool_result",
          event_id: "tool-result:only",
          subject_node_id: "tool",
          start: metric(20),
        }),
      ],
    });
    const result = toolExecutions(owner, owner).executions[0];
    expect(result.startMs).toBeNull();
    expect(result.duration.value).toBe(3);
  });

  it("does not merge conflicting streams or ambiguous duplicate subject IDs", () => {
    const duplicateA = makeTool("dup", "Read");
    const duplicateB = makeTool("dup", "Read");
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      children: [duplicateA, duplicateB],
      execution_events: [
        makeExecutionEvent({
          kind: "tool_start",
          event_id: "tool-start:same",
          subject_node_id: "dup",
          source_stream_id: "A",
          start: metric(1),
        }),
        makeExecutionEvent({
          kind: "tool_result",
          event_id: "tool-result:same",
          subject_node_id: "dup",
          source_stream_id: "B",
          start: metric(2),
        }),
        makeExecutionEvent({
          kind: "tool_start",
          event_id: "tool-start:other",
          source_stream_id: "C",
          start: metric(3),
        }),
        makeExecutionEvent({
          kind: "tool_result",
          event_id: "tool-result:other",
          source_stream_id: "D",
          start: metric(4),
        }),
      ],
    });
    const { executions, byEventIndex } = toolExecutions(owner, owner);
    expect(executions).toHaveLength(6);
    expect(executions.filter((e) => e.pairing === "unpaired")).toHaveLength(4);
    expect(executions.slice(0, 2).every((e) => e.subject === null)).toBe(true);
    expect([...byEventIndex.keys()].sort()).toEqual([0, 1, 2, 3]);
    expect(new Set(executions.flatMap((e) => e.sourceEventIndexes)).size).toBe(4);
    expect(new Set(executions.map((e) => e.key)).size).toBe(executions.length);
  });

  it("preserves the input evidence and reports measured subject duration", () => {
    const event = makeExecutionEvent({
      kind: "tool_start",
      event_id: "tool-start:i",
      subject_node_id: "tool",
      start: metric(5),
    });
    const tool = makeTool("tool", "Read", { start: metric(4), duration: metric(3, "source") });
    const owner = makeNode({ node_id: "owner", kind: "agent", children: [tool], execution_events: [event] });
    const snapshot = structuredClone(owner);
    const { executions } = toolExecutions(owner, owner);
    expect(executions[0].duration).toEqual(metric(3, "source"));
    expect(owner).toEqual(snapshot);
  });

  it("does not pair conflicting invocation IDs on one resolved subject", () => {
    const tool = makeTool("tool", "Read");
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      children: [tool],
      execution_events: [
        makeExecutionEvent({
          kind: "tool_start",
          event_id: "tool-start:first",
          subject_node_id: "tool",
          start: metric(1),
        }),
        makeExecutionEvent({
          kind: "tool_result",
          event_id: "tool-result:second",
          subject_node_id: "tool",
          start: metric(2),
        }),
      ],
    });
    const { executions, byEventIndex } = toolExecutions(owner, owner);
    expect(executions).toHaveLength(2);
    expect(executions.every((e) => e.pairing === "unpaired" && e.subject === tool)).toBe(true);
    expect(executions[0].key).not.toBe(executions[1].key);
    expect([...byEventIndex.keys()].sort()).toEqual([0, 1]);
  });

  it("retains invocation-bearing delegation and untimed evidence", () => {
    const tool = makeTool("tool", "Subagent");
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      children: [tool],
      execution_events: [
        makeExecutionEvent({ kind: "delegation", event_id: "tool-start:delegate:child", subject_node_id: "tool" }),
      ],
    });
    const { executions, byEventIndex } = toolExecutions(owner, owner);
    expect(executions).toHaveLength(1);
    expect(executions[0].pairing).toBe("subject");
    expect(executions[0].startMs).toBeNull();
    expect(executions[0].duration.value).toBeNull();
    expect(executions[0].sourceEventIndexes).toEqual([0]);
    expect(byEventIndex.get(0)).toBe(executions[0]);
  });
});
