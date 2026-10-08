// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { makeCall, makeNode, makeTool, metric } from "../test/factories";
import {
  activityOf,
  axisLabels,
  bar,
  mergeSegments,
  nodeSpan,
  placeSegments,
  segmentsAt,
  ticks,
  zoom,
} from "./timeline";

const view = { start: 1000, end: 2000 };

describe("nodeSpan", () => {
  it("uses the node's start and end", () => {
    expect(nodeSpan(makeNode({ node_id: "s", start: metric(1000), end: metric(2000) }))).toEqual(view);
    expect(nodeSpan(makeNode({ node_id: "s", start: metric(1000) }))).toEqual({ start: 1000, end: 1001 });
    expect(nodeSpan(makeNode({ node_id: "s" }))).toBeNull();
  });
});

describe("zoom", () => {
  it("selects a percentage range of the span", () => {
    expect(zoom(view, 25, 50)).toEqual({ start: 1250, end: 1500 });
  });
});

describe("bar", () => {
  it("places a span in percent of the view", () => {
    expect(bar(1250, 1500, view)).toEqual({ left: 25, width: 25 });
  });

  it("clips to the view and keeps a minimum width", () => {
    expect(bar(500, 1100, view)).toEqual({ left: 0, width: 10 });
    expect(bar(1500, null, view)?.width).toBeGreaterThan(0);
    expect(bar(3000, 4000, view)).toBeNull();
    expect(bar(null, null, view)).toBeNull();
  });
});

describe("ticks", () => {
  it("positions LLM calls inside the view", () => {
    const calls = [1500, 3000].map((start) =>
      makeCall({
        start: metric(start),
        duration: metric(),
        model: null,
        cost: { value: null, unit: null, usd: null, provenance: "n/a" },
        in_context: true,
      }),
    );

    expect(ticks(calls, view).map((tick) => tick.pct)).toEqual([50]);
  });
});

describe("axisLabels", () => {
  it("labels evenly spaced times relative to the origin", () => {
    expect(axisLabels(view, 1000, 2).map((label) => [label.pct, label.label])).toEqual([
      [0, "0ms"],
      [50, "500ms"],
      [100, "1.0s"],
    ]);
  });
});

function call(start: number | null, duration: number | null) {
  return makeCall({
    start: metric(start),
    duration: metric(duration),
    model: null,
    cost: { value: null, unit: null, usd: null, provenance: "n/a" },
    in_context: true,
  });
}

const timed = (id: string, start: number | null, end: number | null) =>
  makeTool(id, "Read", { start: metric(start), end: metric(end) });

describe("mergeSegments", () => {
  it("merges overlapping spans and keeps their nodes", () => {
    const segments = mergeSegments([timed("c", 1600, 1700), timed("a", 1000, 1300), timed("b", 1200, 1500)]);

    expect(segments.map((s) => [s.start, s.end, s.nodes.map((n) => n.node_id)])).toEqual([
      [1000, 1500, ["a", "b"]],
      [1600, 1700, ["c"]],
    ]);
  });

  it("does not merge touching spans, treats a missing end as the start, and skips nodes without a start", () => {
    const segments = mergeSegments([
      timed("a", 1000, 1200),
      timed("b", 1200, 1300),
      timed("c", 1400, null),
      timed("d", null, null),
    ]);

    expect(segments.map((s) => [s.start, s.end])).toEqual([
      [1000, 1200],
      [1200, 1300],
      [1400, 1400],
    ]);
  });
});

describe("activityOf", () => {
  it("splits a node's activity into LLM spans, LLM ticks, tool and sub-agent segments", () => {
    const node = makeNode({
      node_id: "turn",
      kind: "turn",
      llm_calls: [call(1000, 100), call(1500, null), call(null, 50)],
      children: [
        timed("read", 1100, 1200),
        makeNode({ node_id: "agent", kind: "agent", start: metric(1200), end: metric(1800) }),
      ],
    });

    const activity = activityOf(node);

    expect(activity.llm).toEqual([{ start: 1000, end: 1100 }]);
    expect(activity.llmTicks.map((c) => c.start.value)).toEqual([1500]);
    expect(activity.tools.map((s) => s.nodes[0].node_id)).toEqual(["read"]);
    expect(activity.agents.map((s) => s.nodes[0].node_id)).toEqual(["agent"]);
  });
});

describe("placeSegments and segmentsAt", () => {
  it("places segments in the view and finds those under a position", () => {
    const placed = placeSegments(
      mergeSegments([timed("a", 1100, 1200), timed("b", 1500, 1600), timed("x", 3000, 3100)]),
      view,
    );

    expect(placed.map((p) => [p.left, p.width])).toEqual([
      [10, 10],
      [50, 10],
    ]);
    expect(segmentsAt(placed, 15).map((s) => s.nodes[0].node_id)).toEqual(["a"]);
    expect(segmentsAt(placed, 30)).toEqual([]);
  });
});
