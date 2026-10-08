// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { makeCall, makeExecutionEvent, makeNode, metric } from "../test/factories";
import { captureWorkflowAnchor, newFollowTarget, observationSignature, restoreWorkflowAnchor } from "./workflowReading";
import { observedItems } from "./workflowState";

describe("workflow reading anchors", () => {
  it("preserves a row and pixel offset when rows are inserted before it", () => {
    const anchor = captureWorkflowAnchor(["a", "b", "c"], 37, 30);
    expect(anchor).toEqual({ key: "b", offset: 7, previousKeys: ["a", "b", "c"] });
    expect(restoreWorkflowAnchor(anchor, ["new", "a", "b", "c"], 30)).toBe(67);
  });

  it("uses the next surviving row when the anchored row disappears", () => {
    const anchor = captureWorkflowAnchor(["a", "b", "c"], 37, 30);
    expect(restoreWorkflowAnchor(anchor, ["a", "c"], 30)).toBe(37);
  });

  it("falls back to the prior surviving row and clamps offsets", () => {
    const anchor = captureWorkflowAnchor(["a", "b", "c"], 89, 30);
    expect(restoreWorkflowAnchor(anchor, ["a"], 30)).toBe(29);
    expect(restoreWorkflowAnchor(anchor, [], 30)).toBe(0);
  });
});

describe("workflow follow observations", () => {
  const observations = (nodes: ReturnType<typeof makeNode>[]) => observedItems(nodes);

  it("ignores identical refetches and metric-only changes", () => {
    const node = makeNode({
      node_id: "worker",
      kind: "agent",
      llm_calls: [makeCall({ call_id: "same", source_stream_id: "s", source_order: 1 })],
    });
    const before = observations([node]);
    const changedMetrics = structuredClone(node);
    changedMetrics.llm_calls[0].tokens.input.value = 999;
    expect(newFollowTarget(before, observations([changedMetrics]), new Set(["worker"]))).toEqual({
      ownerId: null,
      reason: "none",
    });
    expect(newFollowTarget(before, observations([node]), new Set(["worker"]))).toEqual({
      ownerId: null,
      reason: "none",
    });
  });

  it("counts duplicate snapshot signatures without inventing identity", () => {
    const node = makeNode({
      node_id: "worker",
      kind: "agent",
      llm_calls: [
        makeCall({ call_id: null, source_stream_id: "s", source_order: 1 }),
        makeCall({ call_id: null, source_stream_id: "s", source_order: 1 }),
      ],
    });
    const one = observations([{ ...node, llm_calls: node.llm_calls.slice(0, 1) }]);
    const two = observations([node]);
    expect(newFollowTarget(one, two, new Set(["worker"]))).toEqual({ ownerId: "worker", reason: "target" });
    expect(observationSignature(two[0])).toBe(observationSignature(two[1]));
  });

  it("chooses the maximal new owner using same-stream order", () => {
    const previous = observations([
      makeNode({
        node_id: "worker",
        kind: "agent",
        llm_calls: [makeCall({ call_id: "old", source_stream_id: "s", source_order: 1 })],
      }),
    ]);
    const current = observations([
      makeNode({
        node_id: "worker",
        kind: "agent",
        llm_calls: [
          makeCall({ call_id: "old", source_stream_id: "s", source_order: 1 }),
          makeCall({ call_id: "new", source_stream_id: "s", source_order: 2 }),
        ],
      }),
    ]);
    expect(newFollowTarget(previous, current, new Set(["worker"]))).toEqual({ ownerId: "worker", reason: "target" });
  });

  it("marks untimed records from different streams ambiguous", () => {
    const current = observations([
      makeNode({
        node_id: "a",
        kind: "agent",
        llm_calls: [makeCall({ call_id: "a", source_stream_id: "a", start: metric() })],
      }),
      makeNode({
        node_id: "b",
        kind: "agent",
        llm_calls: [makeCall({ call_id: "b", source_stream_id: "b", start: metric() })],
      }),
    ]);
    expect(newFollowTarget([], current, new Set(["a", "b"]))).toEqual({ ownerId: null, reason: "ambiguous" });
  });

  it("returns ambiguous when contradictory evidence forms a comparison cycle", () => {
    const nodes = [
      makeNode({
        node_id: "a",
        kind: "agent",
        llm_calls: [makeCall({ call_id: "a", source_stream_id: "x", source_order: 2, start: metric(100) })],
      }),
      makeNode({
        node_id: "b",
        kind: "agent",
        llm_calls: [makeCall({ call_id: "b", source_stream_id: "x", source_order: 1, start: metric(200) })],
      }),
      makeNode({
        node_id: "c",
        kind: "agent",
        llm_calls: [makeCall({ call_id: "c", source_stream_id: "z", start: metric(150) })],
      }),
    ];
    expect(newFollowTarget([], observations(nodes), new Set(["a", "b", "c"]))).toEqual({
      ownerId: null,
      reason: "ambiguous",
    });
  });

  it("targets a shared owner when all incomparable maxima belong to that owner", () => {
    const current = observations([
      makeNode({
        node_id: "worker",
        kind: "agent",
        llm_calls: [
          makeCall({ call_id: "one", source_stream_id: "a", start: metric() }),
          makeCall({ call_id: "two", source_stream_id: "b", start: metric() }),
        ],
      }),
    ]);
    expect(newFollowTarget([], current, new Set(["worker"]))).toEqual({ ownerId: "worker", reason: "target" });
  });

  it("ignores new records outside the eligible workflow", () => {
    const current = observations([
      makeNode({ node_id: "outside", kind: "agent", llm_calls: [makeCall({ call_id: "new" })] }),
    ]);
    expect(newFollowTarget([], current, new Set(["inside"]))).toEqual({ ownerId: null, reason: "none" });
  });

  it("treats event subject and kind as part of a snapshot signature", () => {
    const a = observations([
      makeNode({
        node_id: "worker",
        kind: "agent",
        execution_events: [makeExecutionEvent({ event_id: "e", kind: "resume", subject_node_id: "worker" })],
      }),
    ]);
    const b = observations([
      makeNode({
        node_id: "worker",
        kind: "agent",
        execution_events: [makeExecutionEvent({ event_id: "e", kind: "completion", subject_node_id: "other" })],
      }),
    ]);
    expect(observationSignature(a[0])).not.toBe(observationSignature(b[0]));
  });

  it("does not use observation array position as identity", () => {
    const current = observations([
      makeNode({ node_id: "a", kind: "agent", llm_calls: [makeCall({ call_id: "a", source_order: 1 })] }),
      makeNode({ node_id: "b", kind: "agent", llm_calls: [makeCall({ call_id: "b", source_order: 2 })] }),
    ]);
    expect(newFollowTarget(current, [...current].reverse(), new Set(["a", "b"]))).toEqual({
      ownerId: null,
      reason: "none",
    });
  });

  it("notices source identity becoming available exactly once", () => {
    const withoutIdentity = observations([
      makeNode({ node_id: "worker", kind: "agent", llm_calls: [makeCall({ start: metric(100) })] }),
    ]);
    const withIdentity = observations([
      makeNode({ node_id: "worker", kind: "agent", llm_calls: [makeCall({ call_id: "native", start: metric(100) })] }),
    ]);
    const eligible = new Set(["worker"]);
    expect(newFollowTarget(withoutIdentity, withIdentity, eligible)).toEqual({ ownerId: "worker", reason: "target" });
    expect(newFollowTarget(withIdentity, withIdentity, eligible)).toEqual({ ownerId: null, reason: "none" });
  });
});
