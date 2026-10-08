// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { NodeOut } from "../api/types";
import { type SequenceEntry, sequenceEntries } from "./executionSequence";

export type WorkflowStatus = "running" | "waiting" | "completed" | "failed" | "unknown";
export type ActivityFilter = "all" | WorkflowStatus;

export interface ObservedItem {
  ownerId: string;
  entry: SequenceEntry;
  timeMs: number | null;
  streamId: string | null;
  sourceOrder: number | null;
}

export interface WorkflowObservation {
  status: WorkflowStatus;
  evidence: "recorded" | "inferred" | "unavailable";
  latest: ObservedItem | null;
  latestTimedAtMs: number | null;
  completionRecorded: boolean;
  taskOwnerId: string | null;
}

export function compareObservedItems(a: ObservedItem, b: ObservedItem): -1 | 0 | 1 {
  if (
    a.streamId !== null &&
    a.streamId === b.streamId &&
    a.sourceOrder !== null &&
    b.sourceOrder !== null &&
    a.sourceOrder !== b.sourceOrder
  ) {
    return a.sourceOrder < b.sourceOrder ? -1 : 1;
  }
  if (a.timeMs !== null && b.timeMs !== null && a.timeMs !== b.timeMs) {
    return a.timeMs < b.timeMs ? -1 : 1;
  }
  return 0;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function observedItems(nodes: readonly NodeOut[]): ObservedItem[] {
  return nodes
    .filter((node) => node.kind !== "tool")
    .flatMap((owner) =>
      sequenceEntries(owner).map((entry) => {
        const record = entry.kind === "call" ? entry.call : entry.event;
        const time = finite(record.start.value);
        const stream = record.source_stream_id;
        return {
          ownerId: owner.node_id,
          entry,
          timeMs: time !== null && time >= 0 ? time : null,
          streamId: typeof stream === "string" && stream.trim().length > 0 ? stream : null,
          sourceOrder: finite(record.source_order),
        };
      }),
    );
}

function ownCompletion(item: ObservedItem): boolean {
  if (item.entry.kind !== "event" || item.entry.event.kind !== "completion") return false;
  const subject = item.entry.event.subject_node_id;
  return subject == null || subject === "" || subject === item.ownerId;
}

export function observeWorkflow(nodes: readonly NodeOut[]): WorkflowObservation {
  const owners = nodes.filter((node) => node.kind !== "tool");
  const items = observedItems(owners);
  const maxima = items.filter((item) => !items.some((other) => compareObservedItems(item, other) === -1));
  const latest = maxima.length === 1 ? maxima[0] : null;
  const times = items.flatMap((item) => (item.timeMs === null ? [] : [item.timeMs]));
  const result: WorkflowObservation = {
    status: "unknown",
    evidence: "unavailable",
    latest,
    latestTimedAtMs: times.length === 0 ? null : times.reduce((a, b) => Math.max(a, b)),
    completionRecorded: items.some(ownCompletion),
    taskOwnerId: latest?.ownerId ?? null,
  };
  if (maxima.length > 0 && maxima.every(ownCompletion)) {
    const failed = maxima.filter((item) => item.entry.kind === "event" && item.entry.event.success === false).length;
    if (failed === maxima.length) return { ...result, status: "failed", evidence: "recorded" };
    if (failed === 0) return { ...result, status: "completed", evidence: "recorded" };
    return result;
  }
  const owner =
    latest === null
      ? items.length === 0 && owners.length === 1
        ? owners[0]
        : null
      : owners.find((node) => node.node_id === latest.ownerId);
  if (owner?.activity === "running" || owner?.activity === "waiting") {
    return { ...result, status: owner.activity, evidence: "inferred" };
  }
  return result;
}
