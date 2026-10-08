// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { CostOut, MetricOut, NodeOut } from "../api/types";

export interface AgentSummaryRow {
  agentId: number;
  topic: string;
  activity: NodeOut["activity"];
  active: boolean;
  /** Distinct models used across the agent's turns, comma-joined; `null` if none are known. */
  model: string | null;
  duration: MetricOut;
  cost: CostOut;
  /** This row's cost as a percentage of the total cost across all agents; `null` if not computable. */
  costPercent: number | null;
  tokensTotal: MetricOut;
  tokensInput: MetricOut;
  tokensOutput: MetricOut;
  cacheTtl: "5m" | "1h" | "mixed" | "unknown";
  resumeCount: number;
}

const PROVENANCE_RANK: Record<string, number> = { exact: 0, estimated: 1, "n/a": 2 };

function worstProvenance(provenances: readonly string[]): string {
  return provenances.reduce(
    (worst, next) => ((PROVENANCE_RANK[next] ?? 2) > (PROVENANCE_RANK[worst] ?? 2) ? next : worst),
    "exact",
  );
}

/** Sums known values, downgrading provenance the same way the backend's roll-ups do. */
function sumMetrics(metrics: readonly { value: number | null; provenance: string }[]): MetricOut {
  const available = metrics.filter((metric): metric is { value: number; provenance: string } => metric.value !== null);
  if (available.length === 0) return { value: null, provenance: "n/a" };
  let provenance = worstProvenance(available.map((metric) => metric.provenance));
  if (available.length < metrics.length) provenance = worstProvenance([provenance, "estimated"]);
  return { value: available.reduce((sum, metric) => sum + metric.value, 0), provenance };
}

/** Turn/agent nodes anywhere in the tree, including ones nested under a tool call. */
function agentNodes(root: NodeOut): NodeOut[] {
  const nodes: NodeOut[] = [];
  const visit = (node: NodeOut): void => {
    if ((node.kind === "turn" || node.kind === "agent") && node.agent_id !== null) nodes.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return nodes;
}

function modelLabel(nodes: readonly NodeOut[]): string | null {
  let models = [...new Set(nodes.map((node) => node.model).filter((model): model is string => model !== null))].sort();
  if (models.length > 1) models = models.filter((model) => !/^<.*>$/.test(model));
  return models.length > 0 ? models.join(", ") : null;
}

function cacheTtl(nodes: readonly NodeOut[]): AgentSummaryRow["cacheTtl"] {
  const writes = nodes.flatMap((node) => node.llm_calls).filter((call) => (call.tokens.cache_write.value ?? 0) > 0);
  if (
    writes.length === 0 ||
    writes.some((call) => call.tokens.cache_write_5m.value === null || call.tokens.cache_write_1h.value === null)
  )
    return "unknown";
  const five = writes.some((call) => (call.tokens.cache_write_5m.value ?? 0) > 0);
  const one = writes.some((call) => (call.tokens.cache_write_1h.value ?? 0) > 0);
  return five && one ? "mixed" : five ? "5m" : "1h";
}

/** One row per distinct agent id: total duration, own USD cost, and own input/output tokens. */
export function agentSummaryRows(root: NodeOut): AgentSummaryRow[] {
  const byAgent = new Map<number, NodeOut[]>();
  for (const node of agentNodes(root)) {
    const agentId = node.agent_id as number;
    const nodes = byAgent.get(agentId);
    if (nodes) nodes.push(node);
    else byAgent.set(agentId, [node]);
  }
  const rows = [...byAgent.entries()]
    .sort(([a], [b]) => a - b)
    .map(([agentId, nodes]) => {
      const representative = agentId === 1 ? root : (nodes.find((node) => node.kind === "agent") ?? nodes[0]);
      const cost = sumMetrics(
        nodes.map((node) => ({ value: node.cost_own.usd, provenance: node.cost_own.provenance })),
      );
      const tokensInput = sumMetrics(nodes.map((node) => node.tokens.input));
      const tokensOutput = sumMetrics(nodes.map((node) => node.tokens.output));
      return {
        agentId,
        topic: representative.topic,
        activity:
          agentId === 1
            ? (nodes.findLast((node) => node.activity === "running" || node.activity === "waiting")?.activity ?? null)
            : representative.activity,
        active: representative.active || representative.active_descendant,
        model: modelLabel(nodes),
        duration: sumMetrics(nodes.map((node) => node.duration)),
        cost: { value: cost.value, unit: "USD", usd: cost.value, provenance: cost.provenance },
        costPercent: null as number | null,
        tokensTotal: sumMetrics([tokensInput, tokensOutput]),
        tokensInput,
        tokensOutput,
        cacheTtl: cacheTtl(nodes),
        resumeCount: nodes.reduce((sum, node) => sum + node.resume_times.length, 0),
      };
    });

  const totalCost = rows.reduce((sum, row) => (row.cost.value === null ? sum : sum + row.cost.value), 0);
  return rows.map((row) => ({
    ...row,
    costPercent: row.cost.value === null || totalCost <= 0 ? null : (row.cost.value / totalCost) * 100,
  }));
}
