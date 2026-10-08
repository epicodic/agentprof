// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { WorkflowLocation } from "./workflowScope";
import type { ActivityFilter } from "./workflowState";

const ACTIVITIES: readonly ActivityFilter[] = ["all", "running", "waiting", "completed", "failed", "unknown"];

export function parseWorkflowLocation(params: URLSearchParams): WorkflowLocation {
  const raw = params.get("activity");
  const valid = raw === null || ACTIVITIES.includes(raw as ActivityFilter);
  return {
    scopeId: params.get("scope") || null,
    activity: valid && raw !== null ? (raw as ActivityFilter) : "all",
    invalidActivity: !valid,
  };
}

export function writeWorkflowLocation(
  params: URLSearchParams,
  next: { scopeId?: string | null; activity?: ActivityFilter },
): URLSearchParams {
  const result = new URLSearchParams(params);
  if (next.scopeId !== undefined) {
    result.delete("scope");
    if (next.scopeId !== null) result.set("scope", next.scopeId);
  }
  if (next.activity !== undefined) {
    result.delete("activity");
    if (next.activity !== "all") result.set("activity", next.activity);
  }
  return result;
}
