// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import type { LlmCallOut } from "../api/types";
import { makeCall, makeNode, metric, tokens } from "../test/factories";
import { compactionMarks, contextAt, contextBars, contextCalls, contextFigures, contextScale } from "./context";

function call(start: number | null, input: number | null, cacheRead: number | null = null): LlmCallOut {
  return makeCall({
    start: metric(start),
    duration: metric(),
    model: null,
    tokens: { ...tokens(input, 5), cache_read: metric(cacheRead) },
    cost: { value: null, unit: null, usd: null, provenance: "n/a" },
    in_context: true,
  });
}

const view = { start: 1000, end: 2000 };

describe("contextCalls", () => {
  it("leaves out calls outside the agent's context", () => {
    const side = { ...call(1300, 5), in_context: false };
    const node = makeNode({ node_id: "t", kind: "turn", llm_calls: [call(1100, 20), side, call(1500, 30)] });

    expect(contextCalls(node).map((c) => c.size)).toEqual([20, 30]);
  });

  it("keeps own calls with a start and a known size, sorted by start, with their parts", () => {
    const node = makeNode({
      node_id: "t",
      kind: "turn",
      llm_calls: [call(1500, 10, 90), call(1100, 20), call(null, 5), call(1200, null)],
    });

    expect(contextCalls(node).map((c) => [c.start, c.size, c.cacheRead, c.cacheWrite, c.uncached])).toEqual([
      [1100, 20, 0, 0, 20],
      [1500, 100, 90, 0, 10],
    ]);
  });
});

describe("contextCalls of a session", () => {
  it("preserves the actual owner and original call index", () => {
    const turn = makeNode({
      node_id: "t",
      kind: "turn",
      llm_calls: [call(1500, 30), { ...call(1200, 9), in_context: false }, call(1100, 20)],
    });
    const session = makeNode({ node_id: "s", kind: "session", children: [turn] });

    expect(contextCalls(session).map((item) => [item.owner.node_id, item.index])).toEqual([
      ["t", 2],
      ["t", 0],
    ]);
  });

  it("collects the calls of all turns, but none of their sub-agents", () => {
    const agent = makeNode({ node_id: "a", kind: "agent", llm_calls: [call(1250, 999)] });
    const first = makeNode({ node_id: "t1", kind: "turn", llm_calls: [call(1000, 100), call(1100, 200)] });
    const second = makeNode({ node_id: "t2", kind: "turn", llm_calls: [call(1300, 300)], children: [agent] });
    const session = makeNode({ node_id: "s", kind: "session", children: [second, first] });

    expect(contextCalls(session).map((c) => c.size)).toEqual([100, 200, 300]);
  });

  it("gives the session figures from the whole context", () => {
    const first = makeNode({ node_id: "t1", kind: "turn", llm_calls: [call(1000, 100), call(1100, 300)] });
    const second = makeNode({ node_id: "t2", kind: "turn", llm_calls: [call(1200, 50), call(1300, 150)] });
    const session = makeNode({
      node_id: "s",
      kind: "session",
      children: [first, second],
      context_peak: metric(300),
      compactions: [metric(1200, "estimated")],
    });

    expect(contextFigures(session)).toEqual({ peak: 300, compactions: 1, growth: 150 });
  });
});

describe("contextFigures", () => {
  it("returns peak, compactions and growth without the steps across compactions", () => {
    const node = makeNode({
      node_id: "t",
      kind: "turn",
      llm_calls: [call(1000, 100), call(1100, 300), call(1200, 50), call(1300, 150)],
      context_peak: metric(300),
      compactions: [metric(1200, "estimated")],
    });

    expect(contextFigures(node)).toEqual({ peak: 300, compactions: 1, growth: 150 });
  });

  it("is null without calls of known size", () => {
    expect(contextFigures(makeNode({ node_id: "t", kind: "turn", llm_calls: [call(1000, null)] }))).toBeNull();
  });
});

describe("contextAt", () => {
  it("returns the latest call at or before a time", () => {
    const calls = contextCalls(makeNode({ node_id: "t", kind: "turn", llm_calls: [call(1100, 10), call(1500, 20)] }));

    expect(contextAt(calls, 1050)).toBeNull();
    expect(contextAt(calls, 1100)?.size).toBe(10);
    expect(contextAt(calls, 1900)?.size).toBe(20);
  });
});

describe("contextScale, contextBars and compactionMarks", () => {
  const node = makeNode({
    node_id: "t",
    kind: "turn",
    llm_calls: [call(1100, 50, 150), call(1500, 100)],
    compactions: [metric(1300, "estimated"), metric(5000)],
  });
  const calls = contextCalls(node);

  it("scales to the largest call, at least 1", () => {
    expect(contextScale(calls)).toBe(200);
    expect(contextScale([])).toBe(1);
  });

  it("places one stacked bar per call that lasts until the next call, the last one until the end of the view", () => {
    const bars = contextBars(calls, view, 400);

    expect(bars.map((b) => [b.left, b.cacheRead, b.cacheWrite, b.uncached])).toEqual([
      [10, 37.5, 0, 12.5],
      [50, 0, 0, 25],
    ]);
    expect(bars.map((b) => b.width)).toEqual([40, 50]);
  });

  it("marks compactions inside the view", () => {
    expect(compactionMarks(node, view)).toEqual([{ key: "compaction-0", pct: 30 }]);
  });
});
