// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { makeCall, makeNode, makeTool, metric } from "../test/factories";
import { deepWorkflow } from "../test/workflowFixtures";
import { agentSummaryRows } from "./agentSummary";
import { buildWorkflowIndex, resolveWorkflowScope, workflowAncestors, workflowVisibility } from "./workflowScope";

describe("buildWorkflowIndex", () => {
  it("retains only a matching branch and its contextual ancestors", () => {
    const root = deepWorkflow(3, 2);
    const index = buildWorkflowIndex(root);
    const scope = resolveWorkflowScope(index, "deep-1");
    const result = workflowVisibility(index, scope.root.node_id, "running");
    expect([...result.matches]).toEqual(["deep-3"]);
    expect(result.visible).toEqual(new Set(["deep-1", "deep-2", "deep-3"]));
    expect(result.contextOnly.has("deep-1")).toBe(true);
    expect(workflowAncestors(index, "deep-3").map((node) => node.node_id)).toEqual([
      "session",
      "turn",
      "deep-0",
      "deep-1",
      "deep-2",
      "deep-3",
    ]);
  });

  it("indexes a deep tree, many siblings, and resumed logical-agent nodes without changing metrics", () => {
    const root = deepWorkflow(20, 1000);
    const resumed = makeNode({
      node_id: "resumed",
      kind: "agent",
      agent_id: 9,
      activity: "waiting",
      cost_own: { value: 3, unit: "USD", usd: 3, provenance: "exact" },
      llm_calls: [makeCall({ call_id: "resume-request", start: metric(2000) })],
    });
    root.children[0].children.push(resumed);
    const summaryBefore = JSON.stringify(agentSummaryRows(root));
    const metricsBefore = JSON.stringify([root.cost_total, root.tokens_total, resumed.cost_own]);
    const index = buildWorkflowIndex(root);
    expect(index.depths.get("deep-20")).toBe(22);
    expect(index.nodes.size).toBe(1024);
    expect(index.agentNodeIds.get(9)).toEqual(["deep-7", "resumed"]);
    expect(index.agentNodeIds.get(1)).toContain("turn");
    expect(index.agentNodeIds.get(1)).toContain("sibling-999");
    expect(index.agentObservations.get(9)?.latest?.ownerId).toBe("resumed");
    expect(index.items.filter((item) => item.ownerId === "resumed")).toHaveLength(1);
    expect(JSON.stringify([root.cost_total, root.tokens_total, resumed.cost_own])).toBe(metricsBefore);
    expect(JSON.stringify(agentSummaryRows(root))).toBe(summaryBefore);
    expect(workflowAncestors(index, "missing")).toEqual([]);
  });

  it("indexes tool ancestry while excluding tool subtrees from workflow visibility", () => {
    const buried = makeNode({ node_id: "buried", kind: "agent", activity: "running" });
    const tool = makeTool("tool", "wrapper", { children: [buried] });
    const root = makeNode({ node_id: "root", kind: "session", children: [tool] });
    const index = buildWorkflowIndex(root);
    expect(workflowAncestors(index, "buried").map((node) => node.node_id)).toEqual(["root", "tool", "buried"]);
    expect(index.observations.get("tool")).toMatchObject({ status: "unknown", evidence: "unavailable" });
    expect(resolveWorkflowScope(index, "tool")).toEqual({ root, unavailable: true });
    expect(workflowVisibility(index, "root", "all").visible).toEqual(new Set(["root"]));
  });

  it("resolves absent and valid root scopes while marking unknown scopes unavailable", () => {
    const root = deepWorkflow();
    const index = buildWorkflowIndex(root);
    expect(resolveWorkflowScope(index, null)).toEqual({ root, unavailable: false });
    expect(resolveWorkflowScope(index, "session")).toEqual({ root, unavailable: false });
    expect(resolveWorkflowScope(index, "missing")).toEqual({ root, unavailable: true });
  });

  it("treats tools, unknown IDs, and missing scopes as whole-session fallback", () => {
    const root = deepWorkflow(1);
    const index = buildWorkflowIndex(root);
    expect(resolveWorkflowScope(index, "sibling-tool").root).toBe(root);
    expect(resolveWorkflowScope(index, "unknown").root).toBe(root);
    expect(workflowVisibility(index, "missing", "all").visible.size).toBe(4);
    expect(workflowVisibility(index, "deep-0", "failed").visible).toEqual(new Set());
  });
});
