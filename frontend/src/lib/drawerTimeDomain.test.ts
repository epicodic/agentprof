// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "vitest";
import { makeCall, makeNode, metric } from "../test/factories";
import { drawerTimeDomain } from "./drawerTimeDomain";

test("includes observed span and outlying call or child timestamps", () => {
  const node = makeNode({
    node_id: "turn",
    kind: "turn",
    start: metric(100),
    end: metric(200),
    llm_calls: [makeCall({ start: metric(250), duration: metric(30) })],
    children: [makeNode({ node_id: "agent", kind: "agent", start: metric(50), end: metric(150) })],
  });
  expect(drawerTimeDomain(node)).toEqual({ start: 50, end: 280 });
});

test("uses main agent calls across turns when the session interval is missing", () => {
  const node = makeNode({
    node_id: "session",
    kind: "session",
    children: [
      makeNode({ node_id: "turn", kind: "turn", llm_calls: [makeCall({ start: metric(100), duration: metric(200) })] }),
    ],
  });
  expect(drawerTimeDomain(node)).toEqual({ start: 100, end: 300 });
});

test("keeps unavailable timing unavailable and pads a single plotting timestamp", () => {
  expect(drawerTimeDomain(makeNode({ node_id: "none", start: metric(Number.NaN), end: metric(Infinity) }))).toBeNull();
  expect(drawerTimeDomain(makeNode({ node_id: "one", start: metric(100) }))).toEqual({ start: 100, end: 1100 });
});
