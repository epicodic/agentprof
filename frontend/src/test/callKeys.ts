// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

// Test-only mirror of the server's call keys (src/agentprof/analysis/identity.py) for synthetic sessions that never
// pass through the server. Production code reads `call_key` from the API and never computes it.

import type { LlmCallOut, NodeOut, SessionOut } from "../api/types";

function keysOf(calls: readonly LlmCallOut[]): (string | null)[] {
  const ids = new Map<string, number>();
  const starts = new Map<number, number>();
  for (const call of calls) {
    if (call.call_id) ids.set(call.call_id, (ids.get(call.call_id) ?? 0) + 1);
    const start = call.start.value;
    if (start !== null && Number.isFinite(start)) starts.set(start, (starts.get(start) ?? 0) + 1);
  }
  return calls.map((call) => {
    if (call.call_id) return ids.get(call.call_id) === 1 ? `id:${call.call_id}` : null;
    const start = call.start.value;
    return call.start.provenance === "exact" && start !== null && Number.isFinite(start) && starts.get(start) === 1
      ? `time:${start}`
      : null;
  });
}

/** Set `call_key` on every call of a synthetic tree, as the server would; mutates and returns `value`. */
export function withCallKeys<T extends NodeOut | SessionOut>(value: T): T {
  const visit = (node: NodeOut): void => {
    const keys = keysOf(node.llm_calls);
    node.llm_calls.forEach((call, index) => {
      call.call_key = keys[index];
    });
    for (const child of node.children) visit(child);
  };
  visit("root" in value ? (value as SessionOut).root : (value as NodeOut));
  return value;
}
