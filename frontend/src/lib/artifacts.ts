// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { NodeOut } from "../api/types";

export interface Artifact {
  path: string;
  /** `created` if the first call on the path wrote the whole file. */
  action: "created" | "modified";
  edits: number;
  failed: boolean;
  toolIds: string[];
}

/** Files written or edited by the node's own direct tool calls, in order of first touch. */
export function artifacts(node: NodeOut): Artifact[] {
  const byPath = new Map<string, Artifact>();
  for (const child of node.children) {
    const tool = child.tool;
    if (child.kind !== "tool" || tool === null || tool.category !== "edit") continue;
    const failed = child.success === false;
    for (const path of tool.paths) {
      const known = byPath.get(path);
      if (known === undefined) {
        byPath.set(path, {
          path,
          action: tool.writes_file ? "created" : "modified",
          edits: 1,
          failed,
          toolIds: [child.node_id],
        });
      } else {
        known.edits += 1;
        known.failed = known.failed || failed;
        if (!known.toolIds.includes(child.node_id)) known.toolIds.push(child.node_id);
      }
    }
  }
  return [...byPath.values()];
}
