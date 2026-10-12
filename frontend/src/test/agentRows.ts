// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

// Test-only agent rows for synthetic sessions that never pass through the server
// (src/agentprof/analysis/agent_summary.py builds the real ones). Rows carry identity only; metrics are n/a.

import type { AgentSummaryRowOut, MetricOut, NodeOut, SessionOut } from "../api/types";

const NA: MetricOut = { value: null, provenance: "n/a" };
const NA_COST = { value: null, unit: null, usd: null, provenance: "n/a" };
const NA_TOKENS = {
  input: NA,
  output: NA,
  cache_read: NA,
  cache_write: NA,
  cache_write_5m: NA,
  cache_write_1h: NA,
};

/** One row per agent id in `root`, as the server groups them. */
export function agentRows(root: NodeOut): AgentSummaryRowOut[] {
  const owned = new Map<number, NodeOut[]>([[1, []]]);
  const visit = (node: NodeOut): void => {
    if ((node.kind === "turn" || node.kind === "agent") && node.agent_id !== null) {
      const nodes = owned.get(node.agent_id);
      if (nodes === undefined) owned.set(node.agent_id, [node]);
      else nodes.push(node);
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return [...owned.entries()]
    .sort(([a], [b]) => a - b)
    .map(([agentId, nodes]) => {
      const representative = agentId === 1 ? root : (nodes.find((node) => node.kind === "agent") ?? nodes[0]);
      return {
        agent_id: agentId,
        harness_agent_id: representative.harness_agent_id,
        parent_agent_id: null,
        topic: representative.topic,
        models: [...new Set(nodes.flatMap((node) => (node.model === null ? [] : [node.model])))].sort(),
        llm_calls: NA,
        duration: NA,
        tokens_in_out: NA,
        context_peak: NA,
        tokens: NA_TOKENS,
        own_cost: NA_COST,
        subtree_cost: NA_COST,
        start: NA,
        end: NA,
        cost_parts: {},
        cache_ttl: "unknown",
        cold_rewrites: NA,
        cold_rewrite_cost: NA_COST,
        longest_gap: NA,
        findings_count: 0,
        resume_count: 0,
      };
    });
}

/** Replace `session.agents` with rows built from its tree; mutates and returns `session`. */
export function withAgentRows(session: SessionOut): SessionOut {
  session.agents = agentRows(session.root);
  return session;
}
