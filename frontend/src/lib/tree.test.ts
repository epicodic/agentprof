// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import type { FindingOut } from "../api/types";
import { makeNode, makeTool, metric } from "../test/factories";
import {
  allFindings,
  countLlmCalls,
  countToolCalls,
  findNode,
  flattenTree,
  initialExpansion,
  navigationParentId,
  nodesWithFindings,
  revealKeys,
  rowFindingCount,
  rowKeyOf,
  rowNodes,
  sortFindings,
  subAgents,
  toolCalls,
  turns,
} from "./tree";

function finding(nodeId: string, heuristicId: string, severity: string): FindingOut {
  return {
    heuristic_id: heuristicId,
    node_id: nodeId,
    severity,
    message: `${heuristicId} on ${nodeId}`,
    evidence: {},
    estimated_avoidable_cost: { value: null, unit: null, usd: null, provenance: "n/a" },
  };
}

function sampleRoot() {
  const agent = makeNode({
    node_id: "agent",
    kind: "agent",
    children: [makeTool("grep", "Grep")],
    findings: [finding("agent", "W6", "low")],
  });
  const turn = makeNode({
    node_id: "turn",
    kind: "turn",
    children: [makeTool("r1", "Read"), makeTool("r2", "Read"), makeTool("r3", "Read"), agent, makeTool("bash", "Bash")],
  });
  const quiet = makeNode({ node_id: "quiet", kind: "turn", children: [makeTool("r4", "Read")] });
  return makeNode({ node_id: "session", kind: "session", children: [turn, quiet] });
}

const keys = (rows: { key: string }[]) => rows.map((row) => row.key);

describe("rowNodes", () => {
  it("visits every row in depth-first order without descending into tools", () => {
    const inner = makeNode({ node_id: "inner", kind: "agent" });
    const outer = makeNode({
      node_id: "outer",
      kind: "agent",
      children: [makeTool("read", "Read"), inner],
    });
    const turn = makeNode({ node_id: "turn", kind: "turn", children: [outer] });
    const tool = makeTool("tool", "Bash", {
      children: [makeNode({ node_id: "under-tool", kind: "agent" })],
    });
    const quiet = makeNode({ node_id: "quiet", kind: "turn" });
    const root = makeNode({ node_id: "session", kind: "session", children: [turn, tool, quiet] });

    expect(rowNodes(root).map((node) => node.node_id)).toEqual(["session", "turn", "outer", "inner", "quiet"]);
  });
});

describe("flattenTree", () => {
  it("shows the session, its turns and agents, never tool calls", () => {
    const root = sampleRoot();

    const rows = flattenTree(root, initialExpansion(root));

    expect(keys(rows)).toEqual(["session", "turn", "agent", "quiet"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 1]);
    expect(rows.map((row) => row.expandable)).toEqual([true, true, false, false]);
  });

  it("hides the turns of a collapsed session", () => {
    expect(keys(flattenTree(sampleRoot(), new Set()))).toEqual(["session"]);
  });

  it("expands nested agents on request", () => {
    const inner = makeNode({ node_id: "inner", kind: "agent" });
    const outer = makeNode({ node_id: "outer", kind: "agent", children: [makeTool("t", "Read"), inner] });
    const turn = makeNode({ node_id: "turn", kind: "turn", children: [outer] });
    const root = makeNode({ node_id: "session", kind: "session", children: [turn] });

    expect(keys(flattenTree(root, new Set(["session", "turn"])))).toEqual(["session", "turn", "outer"]);
    expect(keys(flattenTree(root, new Set(["session", "turn", "outer"])))).toEqual([
      "session",
      "turn",
      "outer",
      "inner",
    ]);
  });

  it("keeps only visible nodes when filtered", () => {
    const root = sampleRoot();

    const rows = flattenTree(root, new Set(["session", "turn", "agent"]), nodesWithFindings(root));

    expect(keys(rows)).toEqual(["session", "turn", "agent"]);
  });

  it("keeps the row of a tool call with findings under the filter", () => {
    const root = sampleRoot();
    root.children[1].children[0].findings = [finding("r4", "W4", "high")];

    const rows = flattenTree(root, initialExpansion(root), nodesWithFindings(root));

    expect(keys(rows)).toEqual(["session", "turn", "agent", "quiet"]);
  });
});

describe("initialExpansion", () => {
  it("expands the session and the turns that have sub-agents", () => {
    expect([...initialExpansion(sampleRoot())]).toEqual(["session", "turn"]);
  });
});

describe("rowFindingCount", () => {
  it("counts a node's own findings and those of its direct tool calls", () => {
    const turn = makeNode({
      node_id: "turn",
      kind: "turn",
      findings: [finding("turn", "W1", "low")],
      children: [
        makeTool("r1", "Read", { findings: [finding("r1", "W4", "high"), finding("r1", "W5", "low")] }),
        makeNode({ node_id: "agent", kind: "agent", findings: [finding("agent", "W6", "low")] }),
      ],
    });

    expect(rowFindingCount(turn)).toBe(3);
  });
});

describe("rowKeyOf", () => {
  it("returns the node's own row, or for a tool call the row of its parent", () => {
    const root = sampleRoot();

    expect(rowKeyOf(root, "session")).toBe("session");
    expect(rowKeyOf(root, "agent")).toBe("agent");
    expect(rowKeyOf(root, "grep")).toBe("agent");
    expect(rowKeyOf(root, "r1")).toBe("turn");
    expect(rowKeyOf(root, "missing")).toBeNull();
  });
});

describe("revealKeys", () => {
  it("returns the ancestors of the node's row", () => {
    const root = sampleRoot();

    expect(revealKeys(root, "agent")).toEqual(["session", "turn"]);
    expect(revealKeys(root, "grep")).toEqual(["session", "turn"]);
    expect(revealKeys(root, "r4")).toEqual(["session"]);
    expect(revealKeys(root, "session")).toEqual([]);
    expect(revealKeys(root, "missing")).toEqual([]);
  });
});

describe("navigationParentId", () => {
  it("goes to the calling agent, skipping turn wrappers", () => {
    const root = makeNode({
      node_id: "session",
      kind: "session",
      children: [
        makeNode({
          node_id: "turn",
          kind: "turn",
          children: [
            makeTool("main-tool", "Read"),
            makeNode({
              node_id: "outer",
              kind: "agent",
              children: [makeTool("agent-tool", "Grep"), makeNode({ node_id: "inner", kind: "agent" })],
            }),
          ],
        }),
      ],
    });

    expect(navigationParentId(root, "main-tool")).toBe("session");
    expect(navigationParentId(root, "agent-tool")).toBe("outer");
    expect(navigationParentId(root, "outer")).toBe("session");
    expect(navigationParentId(root, "inner")).toBe("outer");
    expect(navigationParentId(root, "turn")).toBe("session");
    expect(navigationParentId(root, "session")).toBeNull();
    expect(navigationParentId(root, "missing")).toBeNull();
  });
});

describe("toolCalls and subAgents", () => {
  const turn = makeNode({
    node_id: "turn",
    kind: "turn",
    start: metric(1000),
    children: [
      makeTool("read", "Read", { start: metric(1500), duration: metric(200) }),
      makeNode({ node_id: "agent", kind: "agent", start: metric(2000) }),
      makeTool("bash", "Bash"),
    ],
  });

  it("lists direct tool calls with their start relative to the node", () => {
    expect(toolCalls(turn).map((call) => [call.node.node_id, call.offset])).toEqual([
      ["read", 500],
      ["bash", null],
    ]);
  });

  it("lists direct sub-agents with their start relative to the node", () => {
    expect(subAgents(turn).map((agent) => [agent.node.node_id, agent.offset])).toEqual([["agent", 1000]]);
  });

  it("lists the turns of a session with their start relative to the session", () => {
    const session = makeNode({
      node_id: "s",
      kind: "session",
      start: metric(1000),
      children: [
        makeNode({ node_id: "t1", kind: "turn", start: metric(1000) }),
        makeNode({ node_id: "t2", kind: "turn", start: metric(4000) }),
      ],
    });

    expect(turns(session).map((item) => [item.node.node_id, item.offset])).toEqual([
      ["t1", 0],
      ["t2", 3000],
    ]);
  });

  it("has no relative start when the node has no start", () => {
    const noStart = makeNode({
      node_id: "t",
      kind: "turn",
      children: [makeTool("read", "Read", { start: metric(5) })],
    });

    expect(toolCalls(noStart)[0].offset).toBeNull();
  });
});

describe("findings and counts", () => {
  it("collects, sorts and counts", () => {
    const root = sampleRoot();
    const all = [...allFindings(root), finding("turn", "W1", "medium")];

    expect(sortFindings(all).map((f) => f.heuristic_id)).toEqual(["W1", "W6"]);
    expect([...nodesWithFindings(root)].sort()).toEqual(["agent", "session", "turn"]);
    expect(findNode(root, "grep")?.node_id).toBe("grep");
    expect(countToolCalls(root)).toBe(7);
    expect(countLlmCalls(root)).toBe(0);
  });
});
