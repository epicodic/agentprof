// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import cases from "./callKeyCases.json";
import { withCallKeys } from "./callKeys";
import { makeCall, makeNode, metric } from "./factories";

// The same cases run against the server's rule in tests/analysis/test_call_key_cases.py.
describe("withCallKeys", () => {
  it.each(cases)("matches the server's keys: $name", ({ calls, keys }) => {
    const node = makeNode({
      node_id: "o",
      kind: "turn",
      llm_calls: calls.map((call) => makeCall({ call_id: call.call_id, start: metric(call.start, call.provenance) })),
    });
    expect(withCallKeys(node).llm_calls.map((call) => call.call_key)).toEqual(keys);
  });
});
