// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type {
  CostOut,
  ExecutionEventOut,
  LlmCallOut,
  MetricOut,
  NodeOut,
  SessionOut,
  SummaryOut,
  TokensOut,
} from "../api/types";

export function metric(value: number | null = null, provenance?: string): MetricOut {
  return { value, provenance: provenance ?? (value === null ? "n/a" : "exact") };
}

export function cost(
  value: number | null = null,
  unit: string | null = null,
  provenance?: string,
  usd: number | null = unit === "USD" ? value : null,
): CostOut {
  return { value, unit, usd, provenance: provenance ?? (value === null ? "n/a" : "exact") };
}

export function tokens(input: number | null = null, output: number | null = null): TokensOut {
  return {
    input: metric(input),
    output: metric(output),
    cache_read: metric(),
    cache_write: metric(),
    cache_write_5m: metric(),
    cache_write_1h: metric(),
  };
}

export function makeCall(overrides: Partial<LlmCallOut> = {}): LlmCallOut {
  return {
    call_id: null,
    start: metric(),
    duration: metric(),
    model: null,
    tokens: tokens(),
    cost: cost(),
    in_context: true,
    cost_parts: {},
    price_prefix: null,
    gap: metric(),
    gap_basis: null,
    preceding_events: [],
    cold_reason: "unknown",
    cold_rewrite: false,
    source_request_id: null,
    source_order: null,
    source_stream_id: null,
    timing_basis: "unknown",
    ...overrides,
  };
}

export function makeNode(overrides: Partial<NodeOut> & { node_id: string }): NodeOut {
  return {
    agent_id: null,
    harness_agent_id: null,
    active: false,
    active_descendant: false,
    activity: null,
    kind: "tool",
    topic: overrides.node_id,
    model: null,
    success: null,
    tool: null,
    start: metric(),
    end: metric(),
    duration: metric(),
    user_wait: metric(),
    llm_call_count: metric(),
    tool_call_count: metric(),
    tokens: tokens(),
    tokens_total: tokens(),
    cost_total: cost(),
    cost_own: cost(),
    context_peak: metric(),
    compactions: [],
    resume_times: [],
    llm_calls: [],
    execution_events: [],
    findings: [],
    children: [],
    ...overrides,
  };
}

export function makeExecutionEvent(overrides: Partial<ExecutionEventOut> = {}): ExecutionEventOut {
  return {
    kind: "tool_start",
    event_id: null,
    subject_node_id: null,
    start: metric(),
    source_order: null,
    source_stream_id: null,
    success: null,
    links: [],
    execution_start: metric(),
    execution_end: metric(),
    ...overrides,
  };
}

export function makeTool(nodeId: string, nativeId: string, overrides: Partial<NodeOut> = {}): NodeOut {
  return makeNode({
    node_id: nodeId,
    kind: "tool",
    tool: {
      native_id: nativeId,
      category: "read",
      path: null,
      paths: [],
      line_range: null,
      command: null,
      writes_file: false,
      target_agent_id: null,
      is_resume: false,
      linked_agent_node_id: null,
    },
    ...overrides,
  });
}

export function makeSummary(overrides: Partial<SummaryOut> & { id: string }): SummaryOut {
  return {
    agent: "claude-code",
    title: overrides.id,
    workspace: null,
    state: "summarized",
    mtime: 0,
    start_ms: null,
    last_activity_ms: null,
    end_ms: null,
    file_size: null,
    cost_total: null,
    error: null,
    ...overrides,
  };
}

export function makeSession(root: NodeOut, mtime = 0): SessionOut {
  return {
    id: "claude-code:s",
    agent: "claude-code",
    title: "s",
    workspace: null,
    mtime,
    sources: [],
    diagnostics: { malformed_lines: 0, unknown_tool_ids: {}, warnings: [] },
    root,
  };
}
