// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "vitest";
import type { LlmCallOut } from "../api/types";
import { cost, makeCall, makeNode, metric, tokens } from "../test/factories";
import { costEvents, costMax, costPosition, costSum, costTimeDomain, observedCostSpan } from "./cost";

function call(start: number | null, amount: number | null): LlmCallOut {
  return makeCall({
    start: metric(start),
    duration: metric(),
    model: "model",
    tokens: tokens(2, 3),
    cost: cost(amount, "USD"),
    in_context: true,
  });
}

test("session cost events retain their owning turns and sort by call time", () => {
  const late = makeNode({ node_id: "late", kind: "turn", llm_calls: [call(30, 3)] });
  const early = makeNode({ node_id: "early", kind: "turn", llm_calls: [call(10, 1), call(null, 2)] });
  const agent = makeNode({ node_id: "agent", kind: "agent", llm_calls: [call(20, 50)] });
  const session = makeNode({ node_id: "session", kind: "session", children: [late, early, agent] });

  expect(costEvents(session).map((event) => [event.owner.node_id, event.index, event.call.cost.value])).toEqual([
    ["early", 0, 1],
    ["late", 0, 3],
    ["early", 1, 2],
  ]);
});

test("cost events use sequence tie breakers while preserving owner-local call indexes", () => {
  const firstTurn = makeNode({
    node_id: "turn-a",
    kind: "turn",
    llm_calls: [
      makeCall({ call_id: "stream-z", start: metric(10), source_stream_id: "z", source_order: 0 }),
      makeCall({ call_id: "stream-a-late", start: metric(10), source_stream_id: "a", source_order: 2 }),
      makeCall({ call_id: "stream-a-early", start: metric(10), source_stream_id: "a", source_order: 1 }),
    ],
  });
  const secondTurn = makeNode({
    node_id: "turn-b",
    kind: "turn",
    llm_calls: [makeCall({ call_id: "second-owner", start: metric(10), source_stream_id: "z", source_order: 0 })],
  });
  const session = makeNode({ node_id: "session", kind: "session", children: [firstTurn, secondTurn] });

  expect(costEvents(session).map((event) => [event.owner.node_id, event.index])).toEqual([
    ["turn-a", 2],
    ["turn-a", 1],
    ["turn-a", 0],
    ["turn-b", 0],
  ]);
});

test("agent cost events include only its own calls", () => {
  const child = makeNode({ node_id: "child", kind: "agent", llm_calls: [call(20, 9)] });
  const agent = makeNode({ node_id: "agent", kind: "agent", llm_calls: [call(10, 4)], children: [child] });
  expect(costEvents(agent).map((event) => event.call.cost.value)).toEqual([4]);
});

test("cost chart scales known calls and positions them on the node span", () => {
  const events = costEvents(
    makeNode({ node_id: "turn", kind: "turn", llm_calls: [call(10, 1), call(20, 4), call(30, null)] }),
  );
  expect(costMax(events)).toBe(4);
  expect(events[1] && costPosition(events[1], { start: 10, end: 30 })).toBe(50);
  expect(events[2] && costPosition(events[2], { start: 10, end: 30 })).toBeNull();
});

test("elapsed cost domain falls back to observed starts without inventing call duration", () => {
  const events = costEvents(makeNode({ node_id: "turn", kind: "turn", llm_calls: [call(10, 1), call(30, 4)] }));
  const firstEvent = events.at(0);
  if (firstEvent === undefined) throw new Error("Expected the first call event");
  expect(costTimeDomain(events, null)).toEqual({ start: 10, end: 30 });
  expect(costTimeDomain([firstEvent], null)).toEqual({ start: -990, end: 1010 });
  expect(
    costTimeDomain(costEvents(makeNode({ node_id: "untimed", kind: "turn", llm_calls: [call(null, 1)] })), null),
  ).toBeNull();
  expect(costTimeDomain(events, { start: 0, end: 100 })).toEqual({ start: 0, end: 100 });
});

test("an open node's fabricated timeline minimum is not treated as its cost chart domain", () => {
  const node = makeNode({
    node_id: "open",
    kind: "turn",
    start: { value: 10, provenance: "exact" },
    end: { value: null, provenance: "n/a" },
    llm_calls: [call(20, 1), call(30, 4)],
  });
  const events = costEvents(node);
  expect(observedCostSpan(node)).toBeNull();
  expect(costTimeDomain(events, observedCostSpan(node))).toEqual({ start: 20, end: 30 });
});

test("sum of own calls marks incomplete data as estimated", () => {
  const events = costEvents(
    makeNode({ node_id: "agent", kind: "agent", llm_calls: [call(10, 1), call(20, null), call(30, 2)] }),
  );
  expect(costSum(events)).toEqual({ value: 3, usd: 3, unit: "USD", provenance: "estimated" });
});
