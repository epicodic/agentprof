// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { CostOut, TokensOut } from "../api/types";

export const MISSING = "–";

/** Limit entry captions to 100 Unicode code points, including a trailing ellipsis. */
export function truncateTitle(title: string): string {
  const characters = [...title];
  return characters.length <= 100 ? title : `${characters.slice(0, 99).join("")}…`;
}

const AGENT_LABELS: Record<string, string> = {
  "copilot-vscode": "Copilot",
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** A short display label for an agent id; unmapped agents are shown as-is. */
export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return MISSING;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined) return MISSING;
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsd(value: number): string {
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** Dollars first; a cost in another unit follows in parentheses, e.g. `$0.42 (42.0 cr)`. */
export function formatCost(cost: CostOut | null | undefined): string {
  if (!cost || cost.value === null) return MISSING;
  if (cost.unit === "USD") return formatUsd(cost.value);
  const amount = cost.value.toFixed(cost.value < 10 ? 2 : 1);
  const native = cost.unit === "credits" ? `${amount} cr` : `${amount} ${cost.unit ?? ""}`.trim();
  return cost.usd === null ? native : `${formatUsd(cost.usd)} (${native})`;
}

/** Identify API-equivalent estimates and native credits beside the displayed amount. */
export function costEvidenceLabel(cost: CostOut): string {
  if (cost.unit === "USD" && cost.provenance === "estimated") return "API-equivalent estimate";
  if (cost.unit === "credits") return "Native credits";
  return "Reported cost";
}

/** Prefix estimated values with "≈"; missing values stay a plain dash. */
export function withProvenance(text: string, value: { provenance: string }): string {
  if (text === MISSING) return text;
  return value.provenance === "estimated" ? `≈${text}` : text;
}

export function totalTokens(tokens: TokensOut): number | null {
  const values = [tokens.input, tokens.output, tokens.cache_read, tokens.cache_write]
    .map((metric) => metric.value)
    .filter((value): value is number => value !== null);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

export function formatTimestamp(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return MISSING;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}
