// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { NodeOut } from "../api/types";
import { makeCall, makeNode, metric } from "./factories";

export function deepWorkflow(depth = 20, siblings = 0): NodeOut {
  let branch = makeNode({
    node_id: `deep-${depth}`,
    kind: "agent",
    agent_id: depth + 2,
    topic: "Inspect deep worker",
    activity: "running",
    llm_calls: [makeCall({ call_id: "deep-request", start: metric(1000) })],
  });
  for (let level = depth - 1; level >= 0; level -= 1) {
    branch = makeNode({
      node_id: `deep-${level}`,
      kind: "agent",
      agent_id: level + 2,
      topic: `Delegate level ${level}`,
      activity: "waiting",
      children: [branch],
    });
  }
  return makeNode({
    node_id: "session",
    kind: "session",
    agent_id: 1,
    children: [
      makeNode({ node_id: "turn", kind: "turn", agent_id: 1, children: [branch] }),
      ...Array.from({ length: siblings }, (_, i) =>
        makeNode({ node_id: `sibling-${i}`, kind: "turn", agent_id: 1, topic: `Completed task ${i}` }),
      ),
    ],
  });
}
