// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { cost, makeSummary } from "../test/factories";
import { distinct, durationMs, filterRows, sessionListMetricScales } from "./filters";

const rows = [
  makeSummary({ id: "claude-code:a", title: "Fix the parser", workspace: "/repo/a" }),
  makeSummary({ id: "copilot-vscode:b", agent: "copilot-vscode", title: "Write docs", workspace: "/repo/b" }),
];

describe("filterRows", () => {
  it("filters by agent, workspace and case-insensitive text", () => {
    expect(filterRows(rows, { agent: "copilot-vscode", workspace: null, text: "" }).map((r) => r.id)).toEqual([
      "copilot-vscode:b",
    ]);
    expect(filterRows(rows, { agent: null, workspace: "/repo/a", text: "" }).map((r) => r.id)).toEqual([
      "claude-code:a",
    ]);
    expect(filterRows(rows, { agent: null, workspace: null, text: "PARSER" }).map((r) => r.id)).toEqual([
      "claude-code:a",
    ]);
    expect(filterRows(rows, { agent: null, workspace: null, text: "  " })).toHaveLength(2);
  });
});

describe("distinct", () => {
  it("returns sorted unique non-null values", () => {
    expect(distinct(["b", null, "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("durationMs", () => {
  it("needs both start and end", () => {
    expect(durationMs(makeSummary({ id: "x", start_ms: 1000, end_ms: 4000 }))).toBe(3000);
    expect(durationMs(makeSummary({ id: "x", start_ms: 1000 }))).toBeNull();
  });
});

describe("sessionListMetricScales", () => {
  it("scales durations and USD costs while excluding unavailable metrics", () => {
    const summaries = [
      makeSummary({ id: "high", start_ms: 1000, end_ms: 1100, cost_total: cost(3, "USD") }),
      makeSummary({ id: "low", start_ms: 1000, end_ms: 1010, cost_total: cost(1, "USD") }),
      makeSummary({ id: "missing", start_ms: 1000, cost_total: cost(900, "credits") }),
    ];

    expect(sessionListMetricScales(summaries)).toEqual({
      duration: { p90: 91 },
      cost: { p90: 2.8 },
    });
  });
});
