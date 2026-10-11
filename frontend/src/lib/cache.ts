// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { CostOut, LlmCallOut, MetricOut, NodeOut } from "../api/types";

export type CacheCostCategory = "cache_read" | "cache_write_5m" | "cache_write_1h" | "cache_write";
export type CacheQuantityCategory = CacheCostCategory | "cache_write_total";

export interface CacheProjection<T> {
  own: T;
  inclusive: T;
}

export interface CacheCoverage {
  known: number;
  total: number;
}

export interface CacheAnalysis {
  cacheRead: CacheProjection<MetricOut>;
  cacheWrite: CacheProjection<MetricOut>;
  cacheWrite5m: CacheProjection<MetricOut>;
  cacheWrite1h: CacheProjection<MetricOut>;
  quantityCoverage: Record<CacheQuantityCategory, CacheProjection<CacheCoverage>>;
  categoryCosts: {
    cache_read: CacheProjection<CostOut>;
    cache_write_5m: CacheProjection<CostOut>;
    cache_write_1h: CacheProjection<CostOut>;
    cache_write: CacheProjection<CostOut>;
    coverage: Record<CacheCostCategory, CacheProjection<CacheCoverage>>;
  };
  recordedCost: CacheProjection<CostOut>;
  callCostSubtotal: CacheProjection<CostOut>;
  callCostCoverage: CacheProjection<CacheCoverage>;
  rewriteCount: CacheProjection<MetricOut>;
  rewriteWriteCost: CacheProjection<CostOut>;
  rewriteWriteCoverage: CacheProjection<CacheCoverage>;
  costQualifier: string;
  recordedCostLabel: string;
  callCostLabel: string;
}

const PROVENANCE_RANK: Record<string, number> = { exact: 0, estimated: 1, "n/a": 2 };
const COST_CATEGORIES = ["cache_read", "cache_write_5m", "cache_write_1h", "cache_write"] as const;

function worstProvenance(values: readonly string[]): string {
  return values.reduce(
    (worst, value) =>
      (PROVENANCE_RANK[value] ?? PROVENANCE_RANK["n/a"] ?? 2) > (PROVENANCE_RANK[worst] ?? 2) ? value : worst,
    "exact",
  );
}

function sumMetrics(metrics: readonly MetricOut[]): MetricOut {
  const known = metrics.filter((metric): metric is MetricOut & { value: number } => metric.value !== null);
  if (known.length === 0) return { value: null, provenance: "n/a" };
  const provenance = worstProvenance([
    ...known.map((metric) => metric.provenance),
    ...(known.length < metrics.length ? ["estimated"] : []),
  ]);
  return { value: known.reduce((sum, metric) => sum + metric.value, 0), provenance };
}

function metricCoverage(metrics: readonly MetricOut[]): CacheCoverage {
  return { known: metrics.filter((metric) => metric.value !== null).length, total: metrics.length };
}

function costPart(call: LlmCallOut, category: CacheCostCategory): CostOut | null {
  if (category === "cache_write") {
    const five = call.cost_parts.cache_write_5m;
    const one = call.cost_parts.cache_write_1h;
    if (five === undefined || one === undefined || five.value === null || one.value === null) return null;
    if (five.unit !== one.unit) return null;
    return {
      value: five.value + one.value,
      unit: five.unit,
      usd: five.usd !== null && one.usd !== null ? five.usd + one.usd : null,
      provenance: worstProvenance([five.provenance, one.provenance]),
    };
  }
  const part = call.cost_parts[category];
  return part === undefined || part.value === null ? null : part;
}

function sumCosts(costs: readonly (CostOut | null)[]): { cost: CostOut; coverage: CacheCoverage } {
  const known = costs.filter((item): item is CostOut & { value: number } => item !== null && item.value !== null);
  const coverage = { known: known.length, total: costs.length };
  if (known.length === 0 || new Set(known.map((item) => item.unit)).size !== 1) {
    return { cost: { value: null, unit: null, usd: null, provenance: "n/a" }, coverage };
  }
  const usdKnown = known.every((item) => item.usd !== null);
  return {
    cost: {
      value: known.reduce((sum, item) => sum + item.value, 0),
      unit: known[0]?.unit ?? null,
      usd: usdKnown ? known.reduce((sum, item) => sum + (item.usd ?? 0), 0) : null,
      provenance: worstProvenance([
        ...known.map((item) => item.provenance),
        ...(known.length < costs.length ? ["estimated"] : []),
      ]),
    },
    coverage,
  };
}

function descendants(node: NodeOut): NodeOut[] {
  const nodes = [node];
  for (const child of node.children) nodes.push(...descendants(child));
  return nodes;
}

function ledgerCost(node: NodeOut): CacheProjection<CostOut>["own"] {
  if (node.kind !== "session") return node.cost_own;
  const turns = node.children.filter((child) => child.kind === "turn");
  return sumCosts(turns.map((turn) => turn.cost_own)).cost;
}

function costQualifier(agent: string): string {
  if (agent === "copilot-vscode") return "Recorded credits";
  if (agent === "codex") return "API-equivalent USD estimate";
  if (agent === "claude-code") return "Claude pricing estimate";
  return "Cost estimate";
}

function recordedCostLabel(agent: string): string {
  if (agent === "codex") return "API-equivalent node total";
  return agent === "copilot-vscode" ? "Recorded Copilot credits and billing" : "Recorded node cost";
}

function callCostLabel(agent: string): string {
  if (agent === "codex") return "API-equivalent LLM call subtotal";
  if (agent === "copilot-vscode") return "Per-call recorded credit subtotal";
  return "LLM call cost subtotal";
}

function projection<T>(own: T, inclusive: T): CacheProjection<T> {
  return { own, inclusive };
}

/** Summarize cache use, call cost parts, and the node's separately recorded cost ledger. */
export function cacheAnalysis(node: NodeOut, agent: string): CacheAnalysis {
  const nodes = descendants(node);
  const ownCalls =
    node.kind === "session"
      ? node.children.filter((child) => child.kind === "turn").flatMap((turn) => turn.llm_calls)
      : node.llm_calls;
  const inclusiveCalls = nodes.flatMap((item) => item.llm_calls);
  const rewritesOwn = ownCalls.filter((call) => call.cold_rewrite);
  const rewritesInclusive = inclusiveCalls.filter((call) => call.cold_rewrite);
  const costsFor = (calls: readonly LlmCallOut[], category: CacheCostCategory) =>
    sumCosts(calls.map((call) => costPart(call, category)));
  const categoryCosts = Object.fromEntries(
    COST_CATEGORIES.map((category) => {
      const own = costsFor(ownCalls, category);
      const inclusive = costsFor(inclusiveCalls, category);
      return [category, projection(own.cost, inclusive.cost)];
    }),
  ) as Pick<CacheAnalysis["categoryCosts"], CacheCostCategory>;
  const coverage = Object.fromEntries(
    COST_CATEGORIES.map((category) => {
      const own = costsFor(ownCalls, category);
      const inclusive = costsFor(inclusiveCalls, category);
      return [category, projection(own.coverage, inclusive.coverage)];
    }),
  ) as CacheAnalysis["categoryCosts"]["coverage"];
  const rewriteOwn = costsFor(rewritesOwn, "cache_write");
  const rewriteInclusive = costsFor(rewritesInclusive, "cache_write");
  const callCostOwn = sumCosts(ownCalls.map((call) => call.cost));
  const callCostInclusive = sumCosts(inclusiveCalls.map((call) => call.cost));
  const quantityCoverage = {
    cache_read: projection(
      metricCoverage(ownCalls.map((call) => call.tokens.cache_read)),
      metricCoverage(inclusiveCalls.map((call) => call.tokens.cache_read)),
    ),
    cache_write_total: projection(
      metricCoverage(ownCalls.map((call) => call.tokens.cache_write)),
      metricCoverage(inclusiveCalls.map((call) => call.tokens.cache_write)),
    ),
    cache_write_5m: projection(
      metricCoverage(ownCalls.map((call) => call.tokens.cache_write_5m)),
      metricCoverage(inclusiveCalls.map((call) => call.tokens.cache_write_5m)),
    ),
    cache_write_1h: projection(
      metricCoverage(ownCalls.map((call) => call.tokens.cache_write_1h)),
      metricCoverage(inclusiveCalls.map((call) => call.tokens.cache_write_1h)),
    ),
    cache_write: projection(
      metricCoverage(ownCalls.map((call) => call.tokens.cache_write)),
      metricCoverage(inclusiveCalls.map((call) => call.tokens.cache_write)),
    ),
  };

  return {
    cacheRead: projection(
      sumMetrics(ownCalls.map((call) => call.tokens.cache_read)),
      sumMetrics(inclusiveCalls.map((call) => call.tokens.cache_read)),
    ),
    cacheWrite: projection(
      sumMetrics(ownCalls.map((call) => call.tokens.cache_write)),
      sumMetrics(inclusiveCalls.map((call) => call.tokens.cache_write)),
    ),
    cacheWrite5m: projection(
      sumMetrics(ownCalls.map((call) => call.tokens.cache_write_5m)),
      sumMetrics(inclusiveCalls.map((call) => call.tokens.cache_write_5m)),
    ),
    cacheWrite1h: projection(
      sumMetrics(ownCalls.map((call) => call.tokens.cache_write_1h)),
      sumMetrics(inclusiveCalls.map((call) => call.tokens.cache_write_1h)),
    ),
    quantityCoverage,
    categoryCosts: {
      ...categoryCosts,
      coverage,
    },
    recordedCost: projection(ledgerCost(node), node.cost_total),
    callCostSubtotal: projection(callCostOwn.cost, callCostInclusive.cost),
    callCostCoverage: projection(callCostOwn.coverage, callCostInclusive.coverage),
    rewriteCount: projection(metric(rewritesOwn.length), metric(rewritesInclusive.length)),
    rewriteWriteCost: projection(rewriteOwn.cost, rewriteInclusive.cost),
    rewriteWriteCoverage: projection(rewriteOwn.coverage, rewriteInclusive.coverage),
    costQualifier: costQualifier(agent),
    recordedCostLabel: recordedCostLabel(agent),
    callCostLabel: callCostLabel(agent),
  };
}

function metric(value: number): MetricOut {
  return { value, provenance: "exact" };
}
