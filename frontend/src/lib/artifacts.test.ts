// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import type { NodeOut } from "../api/types";
import { makeNode, makeTool } from "../test/factories";
import { artifacts } from "./artifacts";

function edit(id: string, path: string | string[] | null, writesFile = false, success: boolean | null = true): NodeOut {
  const paths = path === null ? [] : typeof path === "string" ? [path] : path;
  return makeTool(id, writesFile ? "Write" : "Edit", {
    success,
    tool: {
      native_id: writesFile ? "Write" : "Edit",
      category: "edit",
      path: paths[0] ?? null,
      paths,
      line_range: null,
      command: null,
      writes_file: writesFile,
      target_agent_id: null,
      is_resume: false,
      linked_agent_node_id: null,
    },
  });
}

describe("artifacts", () => {
  it("lists files of the node's own edit calls in order of first touch", () => {
    const turn = makeNode({
      node_id: "turn",
      kind: "turn",
      children: [
        edit("e1", "b.py"),
        edit("w1", "a.py", true),
        edit("e2", "a.py", false, false),
        edit("e3", "b.py"),
        makeTool("r1", "Read"),
        edit("e4", null),
        makeNode({ node_id: "agent", kind: "agent", children: [edit("e5", "c.py", true)] }),
      ],
    });

    expect(artifacts(turn)).toEqual([
      { path: "b.py", action: "modified", edits: 2, failed: false, toolIds: ["e1", "e3"] },
      { path: "a.py", action: "created", edits: 2, failed: true, toolIds: ["w1", "e2"] },
    ]);
  });

  it("lists every file of a multi-file edit call", () => {
    const turn = makeNode({
      node_id: "turn",
      kind: "turn",
      children: [edit("e1", "a.py"), edit("m1", ["b.py", "a.py"])],
    });

    expect(artifacts(turn)).toEqual([
      { path: "a.py", action: "modified", edits: 2, failed: false, toolIds: ["e1", "m1"] },
      { path: "b.py", action: "modified", edits: 1, failed: false, toolIds: ["m1"] },
    ]);
  });

  it("keeps each repeated path's direct producer identities in encounter order", () => {
    const turn = makeNode({
      node_id: "turn",
      kind: "turn",
      children: [edit("e1", ["a.py", "b.py"]), edit("e2", "a.py"), edit("e3", "a.py")],
    });

    expect(artifacts(turn)).toEqual([
      { path: "a.py", action: "modified", edits: 3, failed: false, toolIds: ["e1", "e2", "e3"] },
      { path: "b.py", action: "modified", edits: 1, failed: false, toolIds: ["e1"] },
    ]);
  });

  it("is empty without edit calls", () => {
    expect(artifacts(makeNode({ node_id: "turn", kind: "turn", children: [makeTool("r1", "Read")] }))).toEqual([]);
  });
});
