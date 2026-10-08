// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { compareObservedItems, type ObservedItem } from "./workflowState";

export interface WorkflowAnchor {
  key: string | null;
  offset: number;
  previousKeys: readonly string[];
}

export interface WorkflowFollowResult {
  ownerId: string | null;
  reason: "target" | "none" | "ambiguous";
}

export function captureWorkflowAnchor(keys: readonly string[], scrollTop: number, rowHeight: number): WorkflowAnchor {
  const index = Math.min(Math.max(0, Math.floor(scrollTop / rowHeight)), Math.max(0, keys.length - 1));
  return { key: keys[index] ?? null, offset: Math.max(0, scrollTop - index * rowHeight), previousKeys: [...keys] };
}

export function restoreWorkflowAnchor(anchor: WorkflowAnchor, keys: readonly string[], rowHeight: number): number {
  if (keys.length === 0) return 0;
  let key = anchor.key;
  if (key === null || !keys.includes(key)) {
    const oldIndex = anchor.key === null ? 0 : anchor.previousKeys.indexOf(anchor.key);
    key =
      anchor.previousKeys.slice(Math.max(0, oldIndex + 1)).find((id) => keys.includes(id)) ??
      [...anchor.previousKeys.slice(0, Math.max(0, oldIndex))].reverse().find((id) => keys.includes(id)) ??
      keys[0];
  }
  return keys.indexOf(key) * rowHeight + Math.min(anchor.offset, rowHeight - 1);
}

export function observationSignature(item: ObservedItem): string {
  const entry = item.entry;
  return JSON.stringify([
    item.ownerId,
    entry.kind,
    entry.kind === "call" ? (entry.call.call_id ?? null) : (entry.event.event_id ?? null),
    entry.kind === "event" ? entry.event.kind : null,
    entry.kind === "event" ? (entry.event.subject_node_id ?? null) : null,
    item.streamId,
    item.sourceOrder,
    item.timeMs,
  ]);
}

export function newFollowTarget(
  previous: readonly ObservedItem[],
  current: readonly ObservedItem[],
  eligibleOwnerIds: ReadonlySet<string>,
): WorkflowFollowResult {
  const counts = new Map<string, number>();
  for (const item of previous) {
    const key = observationSignature(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const added: ObservedItem[] = [];
  for (const item of current) {
    const key = observationSignature(item);
    const remaining = counts.get(key) ?? 0;
    if (remaining > 0) counts.set(key, remaining - 1);
    else if (eligibleOwnerIds.has(item.ownerId)) added.push(item);
  }
  if (added.length === 0) return { ownerId: null, reason: "none" };
  const maxima = added.filter((item) => !added.some((other) => compareObservedItems(item, other) === -1));
  if (maxima.length === 0) return { ownerId: null, reason: "ambiguous" };
  const owners = new Set(maxima.map((item) => item.ownerId));
  return owners.size === 1 ? { ownerId: maxima[0].ownerId, reason: "target" } : { ownerId: null, reason: "ambiguous" };
}
