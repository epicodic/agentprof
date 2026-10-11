// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { cost, makeCall, makeNode, metric, tokens } from "../test/factories";
import { cacheAnalysis } from "./cache";

describe("cacheAnalysis", () => {
  it("keeps Claude cache split estimates separate from recorded node cost", () => {
    const call = makeCall({
      tokens: {
        ...tokens(100, 20),
        cache_read: metric(1000),
        cache_write: metric(500),
        cache_write_5m: metric(300),
        cache_write_1h: metric(200),
      },
      cost: cost(0.8, "USD", "exact"),
      cost_parts: {
        cache_read: cost(0.01, "USD", "estimated"),
        cache_write_5m: cost(0.02, "USD", "estimated"),
        cache_write_1h: cost(0.03, "USD", "estimated"),
      },
      in_context: false,
      cold_rewrite: true,
    });
    const node = makeNode({ node_id: "turn", kind: "turn", llm_calls: [call], cost_own: cost(0.8, "USD") });

    const result = cacheAnalysis(node, "claude-code");

    expect(result.cacheRead.own).toEqual(metric(1000));
    expect(result.cacheWrite.inclusive).toEqual(metric(500));
    expect(result.categoryCosts.cache_write.own).toEqual(cost(0.05, "USD", "estimated"));
    expect(result.recordedCost.own).toEqual(cost(0.8, "USD"));
    expect(result.callCostSubtotal.own).toEqual(cost(0.8, "USD"));
    expect(result.costQualifier).toBe("Claude pricing estimate");
    expect(result.rewriteCount.inclusive).toEqual(metric(1));
    expect(result.rewriteWriteCost.inclusive).toEqual(cost(0.05, "USD", "estimated"));
  });

  it("marks Codex TTL quantity and cost unavailable when split data is absent", () => {
    const call = makeCall({
      cost: cost(0.02, "USD", "estimated"),
      tokens: { ...tokens(), cache_write: metric(100), cache_write_5m: metric(), cache_write_1h: metric() },
      cold_rewrite: true,
    });
    const node = makeNode({ node_id: "turn", kind: "turn", llm_calls: [call] });

    const result = cacheAnalysis(node, "codex");

    expect(result.cacheWrite.inclusive).toEqual(metric(100));
    expect(result.cacheWrite5m.inclusive.value).toBeNull();
    expect(result.cacheWrite1h.inclusive.value).toBeNull();
    expect(result.quantityCoverage.cache_write_1h.inclusive).toEqual({ known: 0, total: 1 });
    expect(result.categoryCosts.cache_write.inclusive.value).toBeNull();
    expect(result.costQualifier).toBe("API-equivalent USD estimate");
    expect(result.recordedCostLabel).toBe("API-equivalent node total");
    expect(result.callCostLabel).toBe("API-equivalent LLM call subtotal");
    expect(result.rewriteWriteCost.inclusive.value).toBeNull();
  });

  it("keeps Copilot cache quantities and credits while category costs remain unknown", () => {
    const call = makeCall({
      tokens: {
        ...tokens(),
        cache_read: metric(250),
        cache_write: metric(400),
        cache_write_5m: metric(400),
        cache_write_1h: metric(0),
      },
      cost: cost(2, "credits", "exact", 0.02),
    });
    const node = makeNode({
      node_id: "agent",
      kind: "agent",
      llm_calls: [call],
      cost_own: cost(14, "credits", "exact", 0.14),
      cost_total: cost(14, "credits", "exact", 0.14),
    });

    const result = cacheAnalysis(node, "copilot-vscode");

    expect(result.cacheRead.own).toEqual(metric(250));
    expect(result.cacheWrite.own).toEqual(metric(400));
    expect(result.categoryCosts.cache_read.own.value).toBeNull();
    expect(result.categoryCosts.cache_write.own.value).toBeNull();
    expect(result.recordedCost.own).toEqual(cost(14, "credits", "exact", 0.14));
    expect(result.callCostSubtotal.own).toEqual(cost(2, "credits", "exact", 0.02));
    expect(result.costQualifier).toBe("Recorded credits");
    expect(result.recordedCostLabel).toBe("Recorded Copilot credits and billing");
    expect(result.callCostLabel).toBe("Per-call recorded credit subtotal");
  });

  it("reports partial known category subtotals with call coverage and keeps known zero", () => {
    const known = makeCall({
      cost_parts: { cache_read: cost(0, "USD", "estimated") },
      tokens: { ...tokens(), cache_read: metric(0) },
    });
    const unknown = makeCall();
    const node = makeNode({ node_id: "agent", kind: "agent", llm_calls: [known, unknown] });

    const result = cacheAnalysis(node, "claude-code");

    expect(result.cacheRead.own).toEqual({ value: 0, provenance: "estimated" });
    expect(result.quantityCoverage.cache_read.own).toEqual({ known: 1, total: 2 });
    expect(result.categoryCosts.cache_read.own).toEqual(cost(0, "USD", "estimated"));
    expect(result.categoryCosts.coverage.cache_read.own).toEqual({ known: 1, total: 2 });
    expect(result.categoryCosts.cache_write.own.value).toBeNull();
  });

  it("separates own and inclusive work across nested agents and the session main turns", () => {
    const mainCall = makeCall({ tokens: { ...tokens(), cache_read: metric(10) } });
    const childCall = makeCall({ tokens: { ...tokens(), cache_read: metric(20) } });
    const turn = makeNode({
      node_id: "turn",
      kind: "turn",
      llm_calls: [mainCall],
      cost_own: cost(1, "USD"),
      cost_total: cost(3, "USD"),
      children: [makeNode({ node_id: "agent", kind: "agent", llm_calls: [childCall] })],
    });
    const session = makeNode({
      node_id: "session",
      kind: "session",
      children: [turn],
      cost_own: cost(0, "USD"),
      cost_total: cost(3, "USD"),
    });

    const turnResult = cacheAnalysis(turn, "claude-code");
    const sessionResult = cacheAnalysis(session, "claude-code");

    expect(turnResult.cacheRead.own.value).toBe(10);
    expect(turnResult.cacheRead.inclusive.value).toBe(30);
    expect(sessionResult.cacheRead.own.value).toBe(10);
    expect(sessionResult.cacheRead.inclusive.value).toBe(30);
    expect(sessionResult.recordedCost.own.value).toBe(1);
    expect(sessionResult.recordedCost.inclusive.value).toBe(3);
  });

  it("counts cold rewrite calls once regardless of overlapping finding references", () => {
    const rewrite = makeCall({
      call_id: "rewrite",
      cold_rewrite: true,
      cost_parts: {
        cache_write_5m: cost(0.2, "USD", "estimated"),
        cache_write_1h: cost(0.3, "USD", "estimated"),
      },
    });
    const node = makeNode({
      node_id: "turn",
      kind: "turn",
      llm_calls: [rewrite],
      findings: [
        {
          heuristic_id: "E1",
          node_id: "turn",
          severity: "low",
          message: "rewrite",
          evidence: {},
          estimated_avoidable_cost: cost(),
        },
        {
          heuristic_id: "E2",
          node_id: "turn",
          severity: "low",
          message: "gap",
          evidence: {},
          estimated_avoidable_cost: cost(),
        },
      ],
    });

    const result = cacheAnalysis(node, "claude-code");

    expect(result.rewriteCount.own.value).toBe(1);
    expect(result.rewriteWriteCost.own).toEqual(cost(0.5, "USD", "estimated"));
  });
});
