// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { ExecutionEventOut, LlmCallOut, NodeOut } from "../api/types";

export type SequenceEntry =
  | { kind: "call"; call: LlmCallOut; originalIndex: number }
  | { kind: "event"; event: ExecutionEventOut; originalIndex: number; contextOnly?: boolean; displayLabel?: string };

export type SequenceRow = SequenceEntry | { kind: "group"; events: Extract<SequenceEntry, { kind: "event" }>[] };
export type SequenceOrder = "chronological" | "cost" | "duration" | "tokens";
export type SequenceMode = "compact" | "all";

export type ExecutionBundle = {
  call: Extract<SequenceEntry, { kind: "call" }> | null;
  entries: SequenceEntry[];
};

export type SearchSequenceEntry = SequenceEntry & { contextOnly?: boolean; displayLabel?: string };
export type SearchExecutionBundle = Omit<ExecutionBundle, "entries"> & { entries: SearchSequenceEntry[] };

const POSITIONAL_LABEL = "Positioned after call; request relationship unavailable";

function metricValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function entryTime(entry: SequenceEntry): number | null {
  return entry.kind === "call" ? metricValue(entry.call.start.value) : metricValue(entry.event.start.value);
}

function streamKey(entry: SequenceEntry): string {
  return entry.kind === "call" ? (entry.call.source_stream_id ?? "") : (entry.event.source_stream_id ?? "");
}

function ordinal(entry: SequenceEntry): number | null {
  const value = entry.kind === "call" ? entry.call.source_order : entry.event.source_order;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function compareSequenceEntries(left: SequenceEntry, right: SequenceEntry): number {
  const leftTime = entryTime(left);
  const rightTime = entryTime(right);
  if (leftTime === null && rightTime !== null) return 1;
  if (leftTime !== null && rightTime === null) return -1;
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;

  const leftStream = streamKey(left);
  const rightStream = streamKey(right);
  if (leftStream !== rightStream) return leftStream < rightStream ? -1 : 1;

  const leftOrdinal = ordinal(left);
  const rightOrdinal = ordinal(right);
  if (leftOrdinal === null && rightOrdinal !== null) return 1;
  if (leftOrdinal !== null && rightOrdinal === null) return -1;
  if (leftOrdinal !== null && rightOrdinal !== null && leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;

  if (left.kind !== right.kind) return left.kind === "call" ? -1 : 1;
  return left.originalIndex - right.originalIndex;
}

export function sequenceEntries(node: NodeOut): SequenceEntry[] {
  const entries: SequenceEntry[] = [
    ...node.llm_calls.map((call, originalIndex) => ({ kind: "call" as const, call, originalIndex })),
    ...(node.execution_events ?? []).map((event, originalIndex) => ({ kind: "event" as const, event, originalIndex })),
  ];
  return entries
    .map((entry, serial) => ({ entry, serial }))
    .sort((left, right) => compareSequenceEntries(left.entry, right.entry) || left.serial - right.serial)
    .map(({ entry }) => entry);
}

export function compactSequence(entries: SequenceEntry[]): SequenceRow[] {
  const rows: SequenceRow[] = [];
  let buffer: Extract<SequenceEntry, { kind: "event" }>[] = [];
  let bufferHasKnownTime: boolean | null = null;
  const flush = (): void => {
    if (buffer.length > 0) rows.push({ kind: "group", events: buffer });
    buffer = [];
    bufferHasKnownTime = null;
  };

  for (const entry of entries) {
    if (entry.kind === "call") {
      flush();
      rows.push(entry);
      continue;
    }
    const hasKnownTime = entryTime(entry) !== null;
    if (buffer.length > 0 && bufferHasKnownTime !== hasKnownTime) flush();
    buffer.push(entry);
    bufferHasKnownTime = hasKnownTime;
  }
  flush();
  return rows;
}

export function flattenSequenceRows(rows: SequenceRow[]): SequenceEntry[] {
  return rows.flatMap((row) => (row.kind === "group" ? row.events : [row]));
}

export function callSortValue(call: LlmCallOut, order: SequenceOrder | string): number | null {
  if (order === "cost") return metricValue(call.cost.usd);
  if (order === "duration") return metricValue(call.duration.value);
  if (order === "tokens") {
    const parts = [
      call.tokens.input.value,
      call.tokens.output.value,
      call.tokens.cache_read.value,
      call.tokens.cache_write.value,
    ];
    if (parts.some((part) => metricValue(part) === null)) return null;
    const sum = (parts as number[]).reduce((total, part) => total + part, 0);
    return Number.isFinite(sum) ? sum : null;
  }
  return null;
}

function metadata(values: unknown[]): string {
  const strings = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...strings, ...strings.map((value) => value.replaceAll("_", " "))].join(" ").toLocaleLowerCase();
}

export function searchTextForEvent(event: ExecutionEventOut, subject: NodeOut | null): string {
  const sourceIds = (event.links ?? []).flatMap((link) => [link.source_request_id, link.owner_id]);
  const tool = subject?.tool;
  return metadata([
    event.kind,
    event.event_id,
    event.subject_node_id,
    event.source_stream_id,
    ...sourceIds,
    subject?.topic,
    subject?.model,
    tool?.native_id,
    tool?.category,
    tool?.path,
    ...(tool?.paths ?? []),
    tool?.command,
  ]);
}

function searchTextForCall(call: LlmCallOut): string {
  return metadata([call.call_id, call.source_request_id, call.source_stream_id, call.model]);
}

function nodeMap(root: NodeOut): Map<string, NodeOut> {
  const result = new Map<string, NodeOut>();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop() as NodeOut;
    result.set(node.node_id, node);
    pending.push(...node.children);
  }
  return result;
}

function compareBundleCalls(left: ExecutionBundle, right: ExecutionBundle, order: SequenceOrder): number {
  if (left.call === null || right.call === null) {
    if (left.call === null && right.call !== null) return -1;
    if (left.call !== null && right.call === null) return 1;
    return 0;
  }
  const leftValue = callSortValue(left.call.call, order);
  const rightValue = callSortValue(right.call.call, order);
  if (leftValue === null && rightValue !== null) return 1;
  if (leftValue !== null && rightValue === null) return -1;
  if (leftValue !== null && rightValue !== null && leftValue !== rightValue) return leftValue - rightValue;
  return compareSequenceEntries(left.call, right.call);
}

function compareBundlesByEarliestEntry(left: ExecutionBundle, right: ExecutionBundle): number {
  const leftFirst = [...left.entries].sort(compareSequenceEntries)[0];
  const rightFirst = [...right.entries].sort(compareSequenceEntries)[0];
  if (leftFirst === undefined || rightFirst === undefined)
    return leftFirst === undefined ? (rightFirst === undefined ? 0 : 1) : -1;
  return compareSequenceEntries(leftFirst, rightFirst);
}

/** Group each event once with its recorded same-owner requester or its positional display anchor. */
export function executionBundles(owner: NodeOut, order: SequenceOrder = "chronological"): ExecutionBundle[] {
  const calls = owner.llm_calls.map((call, originalIndex) => ({ kind: "call" as const, call, originalIndex }));
  const bundles: ExecutionBundle[] = calls.map((call) => ({ call, entries: [call] }));
  const leading: ExecutionBundle = { call: null, entries: [] };
  const entries = sequenceEntries(owner);
  const callBundle = new Map<number, ExecutionBundle>();
  for (const bundle of bundles) if (bundle.call !== null) callBundle.set(bundle.call.originalIndex, bundle);

  const requestCounts = new Map<string, number>();
  for (const call of calls) {
    const id = call.call.source_request_id;
    if (typeof id === "string" && id.length > 0) requestCounts.set(id, (requestCounts.get(id) ?? 0) + 1);
  }
  let precedingCall: Extract<SequenceEntry, { kind: "call" }> | null = null;
  for (const entry of entries) {
    if (entry.kind === "call") {
      if (entryTime(entry) !== null) precedingCall = entry;
      continue;
    }
    let target: ExecutionBundle | undefined;
    let recordedRequest = false;
    const requesterMatches = new Map<number, ExecutionBundle>();
    for (const link of entry.event.links ?? []) {
      if (link.relation !== "requested_by" || link.evidence !== "recorded" || link.owner_id !== owner.node_id) continue;
      if (typeof link.source_request_id !== "string" || requestCounts.get(link.source_request_id) !== 1) continue;
      const match = calls.find((call) => call.call.source_request_id === link.source_request_id);
      if (match !== undefined) {
        const bundle = callBundle.get(match.originalIndex);
        if (bundle !== undefined) requesterMatches.set(match.originalIndex, bundle);
      }
    }
    if (requesterMatches.size === 1) {
      target = requesterMatches.values().next().value;
      recordedRequest = target !== undefined;
    }
    if (target === undefined && entryTime(entry) !== null && precedingCall !== null)
      target = callBundle.get(precedingCall.originalIndex);
    if (target === undefined) leading.entries.push(entry);
    else {
      target.entries.push(recordedRequest ? entry : { ...entry, displayLabel: POSITIONAL_LABEL });
    }
  }

  for (const bundle of bundles) {
    const call = bundle.call;
    const events = bundle.entries
      .filter((entry): entry is Extract<SequenceEntry, { kind: "event" }> => entry.kind === "event")
      .sort(compareSequenceEntries);
    bundle.entries = call === null ? events : [call, ...events];
  }
  leading.entries.sort(compareSequenceEntries);
  const sorted = [...bundles].sort((left, right) => compareBundleCalls(left, right, order));
  return leading.entries.length > 0 ? [{ ...leading }, ...sorted] : sorted;
}

/** Filter metadata while retaining a call as a qualified orientation row for matching events. */
export function searchExecutionBundles(
  bundles: ExecutionBundle[],
  query: string,
  order: SequenceOrder = "chronological",
  root?: NodeOut,
): { bundles: SearchExecutionBundle[]; matchCount: number } {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) {
    return {
      bundles: bundles.map((bundle) => ({ ...bundle, entries: bundle.entries })),
      matchCount: bundles.reduce((sum, bundle) => sum + bundle.entries.length, 0),
    };
  }
  const subjects = root === undefined ? null : nodeMap(root);
  const allEntries = bundles.flatMap((bundle) => bundle.entries);
  const eventMatches = new Map<number, boolean>();
  for (const entry of allEntries) {
    if (entry.kind !== "event") continue;
    const subject = subjects?.get(entry.event.subject_node_id ?? "") ?? null;
    eventMatches.set(entry.originalIndex, searchTextForEvent(entry.event, subject).includes(needle));
  }
  const callMatches = new Map<number, boolean>();
  for (const bundle of bundles) {
    if (bundle.call !== null)
      callMatches.set(bundle.call.originalIndex, searchTextForCall(bundle.call.call).includes(needle));
  }
  const matchCount =
    [...eventMatches.values()].filter(Boolean).length + [...callMatches.values()].filter(Boolean).length;
  if (matchCount === 0) return { bundles: [], matchCount: 0 };

  if (order === "chronological") {
    const chronological = [...allEntries].sort(compareSequenceEntries);
    const selectedEvents = new Set<number>();
    const filtered: SearchExecutionBundle[] = [];
    for (const bundle of bundles) {
      if (bundle.call === null || callMatches.get(bundle.call.originalIndex) !== true) continue;
      const callPosition = chronological.findIndex(
        (entry) => entry.kind === "call" && entry.originalIndex === bundle.call?.originalIndex,
      );
      const entries: SearchSequenceEntry[] = [bundle.call];
      const callHasKnownTime = entryTime(bundle.call) !== null;
      for (
        let index = callPosition + 1;
        index < chronological.length && chronological[index].kind === "event";
        index += 1
      ) {
        const event = chronological[index] as Extract<SequenceEntry, { kind: "event" }>;
        if ((entryTime(event) !== null) !== callHasKnownTime) break;
        selectedEvents.add(event.originalIndex);
        entries.push({ ...event, ...(eventMatches.get(event.originalIndex) === true ? {} : { contextOnly: true }) });
      }
      filtered.push({ ...bundle, entries });
    }
    for (const bundle of bundles) {
      const matches = bundle.entries.filter(
        (entry): entry is Extract<SequenceEntry, { kind: "event" }> =>
          entry.kind === "event" &&
          eventMatches.get(entry.originalIndex) === true &&
          !selectedEvents.has(entry.originalIndex),
      );
      if (matches.length === 0) continue;
      const entries: SearchSequenceEntry[] = [];
      if (bundle.call !== null && callMatches.get(bundle.call.originalIndex) !== true)
        entries.push({ ...bundle.call, contextOnly: true });
      entries.push(...matches);
      filtered.push({ ...bundle, entries });
    }
    return { bundles: filtered.sort(compareBundlesByEarliestEntry), matchCount };
  }

  const filtered: SearchExecutionBundle[] = [];
  for (const bundle of bundles) {
    if (bundle.call !== null && callMatches.get(bundle.call.originalIndex) === true) {
      filtered.push({
        ...bundle,
        entries: bundle.entries.map(
          (entry): SearchSequenceEntry =>
            entry.kind === "event" && eventMatches.get(entry.originalIndex) !== true
              ? { ...entry, contextOnly: true }
              : { ...entry },
        ),
      });
      continue;
    }
    const matches = bundle.entries.filter(
      (entry): entry is Extract<SequenceEntry, { kind: "event" }> =>
        entry.kind === "event" && eventMatches.get(entry.originalIndex) === true,
    );
    if (matches.length === 0) continue;
    const entries: SearchSequenceEntry[] = [];
    if (bundle.call !== null) entries.push({ ...bundle.call, contextOnly: true });
    entries.push(...matches);
    filtered.push({ ...bundle, entries });
  }
  return { bundles: filtered.sort((left, right) => compareBundleCalls(left, right, order)), matchCount };
}

type ExecutionRecord = { event: ExecutionEventOut };
type Measurement = { start: number | null; end: number | null };

function invocationSuffix(eventId: string | null | undefined): string | null {
  if (typeof eventId !== "string") return null;
  const match = /^(?:tool-start|tool-result|delegation)(?::|\/)(.+)$/.exec(eventId);
  return match?.[1] || null;
}

function eventIdentity(event: ExecutionEventOut): string | null {
  const suffix = invocationSuffix(event.event_id);
  if (suffix !== null && event.subject_node_id) return `invocation:${suffix}\0subject:${event.subject_node_id}`;
  if (event.event_id) return `event:${event.event_id}`;
  return null;
}

export function executionGroupMetrics(events: ExecutionEventOut[]): {
  executionCount: number;
  eventCount: number;
  elapsedMs: number | null;
  accumulatedMs: number | null;
  elapsedComplete: boolean;
  accumulatedComplete: boolean;
} {
  const actual = events.filter(
    (event) => event.kind === "tool_start" || event.kind === "tool_result" || event.kind === "delegation",
  );
  const groups = new Map<string, ExecutionRecord[]>();
  let unsafeIdentity = false;
  actual.forEach((event, index) => {
    const key = eventIdentity(event);
    if (key === null) unsafeIdentity = true;
    const safeKey = key ?? `unpaired:${index}`;
    const bucket = groups.get(safeKey);
    if (bucket === undefined) groups.set(safeKey, [{ event }]);
    else bucket.push({ event });
  });

  const measurements: Measurement[] = [];
  let accumulated = 0;
  let accumulatedComplete = !unsafeIdentity;
  for (const records of groups.values()) {
    const snapshots = new Set(
      records.map(({ event }) => {
        const start = metricValue(event.execution_start.value);
        const end = metricValue(event.execution_end.value);
        return `${start ?? "?"}/${end ?? "?"}`;
      }),
    );
    if (snapshots.size > 1) {
      measurements.push({ start: null, end: null });
      accumulatedComplete = false;
      continue;
    }
    const event = records[0].event;
    const start = metricValue(event.execution_start.value);
    const end = metricValue(event.execution_end.value);
    if (start === null || end === null || end < start) {
      measurements.push({ start: null, end: null });
      accumulatedComplete = false;
      continue;
    }
    measurements.push({ start, end });
    accumulated += end - start;
  }

  const allKnown = !unsafeIdentity && measurements.every(({ start, end }) => start !== null && end !== null);
  const elapsedStart = allKnown ? Math.min(...measurements.map(({ start }) => start as number)) : null;
  const elapsedEnd = allKnown ? Math.max(...measurements.map(({ end }) => end as number)) : null;
  return {
    executionCount: groups.size,
    eventCount: events.length,
    elapsedMs: groups.size === 0 ? 0 : elapsedStart !== null && elapsedEnd !== null ? elapsedEnd - elapsedStart : null,
    accumulatedMs: accumulated,
    elapsedComplete: allKnown,
    accumulatedComplete,
  };
}
