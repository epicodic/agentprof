// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { makeNode, makeTool } from "../test/factories";
import { findingKey } from "./findingGroups";
import { preserveSafeLocalMark } from "./localMarks";
import { sortFindings } from "./tree";

function edit(path: string) {
  return makeTool("edit-tool", "Edit", {
    tool: {
      native_id: "Edit",
      category: "edit",
      path,
      paths: [path],
      line_range: null,
      command: null,
      writes_file: false,
      target_agent_id: null,
      is_resume: false,
      linked_agent_node_id: null,
    },
  });
}

function finding(message: string, severity: string = "warning", heuristicId = "W4") {
  return {
    heuristic_id: heuristicId,
    node_id: "owner",
    severity,
    message,
    evidence: {},
    estimated_avoidable_cost: { value: null, unit: null, usd: null, provenance: "n/a" },
  };
}

describe("preserveSafeLocalMark", () => {
  it("preserves an artifact path only while its unique owner and path remain", () => {
    const oldRoot = makeNode({
      node_id: "session",
      children: [makeNode({ node_id: "owner", children: [edit("a.py")] })],
    });
    const nextRoot = structuredClone(oldRoot);
    expect(preserveSafeLocalMark({ viewKey: "artifact:owner", key: "a.py" }, oldRoot, nextRoot)).toEqual({
      viewKey: "artifact:owner",
      key: "a.py",
    });
    expect(
      preserveSafeLocalMark(
        { viewKey: "artifact:owner", key: "a.py" },
        oldRoot,
        makeNode({ node_id: "session", children: [makeNode({ node_id: "owner" })] }),
      ),
    ).toBeNull();
  });

  it("remaps a unique finding after sort order changes", () => {
    const oldRoot = makeNode({ node_id: "session", findings: [finding("Marked")] });
    const nextRoot = structuredClone(oldRoot);
    nextRoot.findings.push(finding("Earlier", "warning", "A0"));
    const oldKey = findingKey(sortFindings(oldRoot.findings)[0], 0);
    expect(preserveSafeLocalMark({ viewKey: "session-findings", key: oldKey }, oldRoot, nextRoot)).toEqual({
      viewKey: "session-findings",
      key: "owner:W4:Marked:1",
    });
  });

  it("expires a duplicate finding mark even when the next snapshot has one occurrence", () => {
    const oldRoot = makeNode({ node_id: "session", findings: [finding("Same"), finding("Same")] });
    const nextRoot = structuredClone(oldRoot);
    nextRoot.findings.pop();
    const oldKey = findingKey(sortFindings(oldRoot.findings)[1], 1);
    expect(preserveSafeLocalMark({ viewKey: "session-findings", key: oldKey }, oldRoot, nextRoot)).toBeNull();
  });

  it("expires non-addressable snapshot-local indexes conservatively", () => {
    const root = makeNode({ node_id: "session" });
    expect(
      preserveSafeLocalMark({ viewKey: "call:owner", key: "call-index:2" }, root, structuredClone(root)),
    ).toBeNull();
  });
});
