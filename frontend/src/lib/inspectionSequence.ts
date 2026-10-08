// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { ExecutionEventOut, LlmCallOut, NodeOut } from "../api/types";
import { callSortValue, compareSequenceEntries, type SequenceEntry, type SequenceOrder } from "./executionSequence";
import { type ToolExecution, toolExecutions } from "./toolExecutions";

export type InspectionEntry =
  | { kind: "call"; call: LlmCallOut; originalIndex: number }
  | { kind: "tool"; execution: ToolExecution }
  | { kind: "activity"; event: ExecutionEventOut; originalIndex: number };
export type InspectionRow =
  | InspectionEntry
  | { kind: "tools"; key: string; executions: ToolExecution[]; sourceCount: number };

function sequenceEntry(entry: InspectionEntry): SequenceEntry | null {
  if (entry.kind === "call") return { kind: "call", call: entry.call, originalIndex: entry.originalIndex };
  if (entry.kind === "activity") return { kind: "event", event: entry.event, originalIndex: entry.originalIndex };
  return entry.execution.anchor;
}

function time(entry: InspectionEntry): number | null {
  if (entry.kind === "call") return entry.call.start.value;
  if (entry.kind === "activity") return entry.event.start.value;
  return entry.execution.startMs ?? entry.execution.subject?.start.value ?? null;
}

function compareEntries(left: InspectionEntry, right: InspectionEntry): number {
  const leftSeq = sequenceEntry(left);
  const rightSeq = sequenceEntry(right);
  if (leftSeq && rightSeq) return compareSequenceEntries(leftSeq, rightSeq);
  const leftTime = time(left);
  const rightTime = time(right);
  if (leftTime === null && rightTime !== null) return 1;
  if (leftTime !== null && rightTime === null) return -1;
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
  if (left.kind !== right.kind)
    return left.kind === "call" ? -1 : right.kind === "call" ? 1 : left.kind.localeCompare(right.kind);
  if (left.kind === "call" && right.kind === "call") return left.originalIndex - right.originalIndex;
  if (left.kind === "activity" && right.kind === "activity") return left.originalIndex - right.originalIndex;
  return left.kind === "tool" && right.kind === "tool" ? left.execution.key.localeCompare(right.execution.key) : 0;
}

export function inspectionEntries(owner: NodeOut, root: NodeOut): InspectionEntry[] {
  const projection = toolExecutions(owner, root);
  const toolsByAnchor = new Map<number, ToolExecution>();
  for (const execution of projection.executions) {
    if (execution.anchor?.kind === "event") toolsByAnchor.set(execution.anchor.originalIndex, execution);
  }
  const entries: InspectionEntry[] = owner.llm_calls.map((call, originalIndex) => ({
    kind: "call",
    call,
    originalIndex,
  }));
  for (const [originalIndex, event] of (owner.execution_events ?? []).entries()) {
    const execution = projection.byEventIndex.get(originalIndex);
    if (execution) {
      if (toolsByAnchor.get(originalIndex) === execution) entries.push({ kind: "tool", execution });
    } else {
      entries.push({ kind: "activity", event, originalIndex });
    }
  }
  for (const execution of projection.executions)
    if (execution.anchor === null) entries.push({ kind: "tool", execution });
  return entries.sort(compareEntries);
}

export function groupToolRows(entries: readonly InspectionEntry[]): InspectionRow[] {
  const rows: InspectionRow[] = [];
  let group: ToolExecution[] = [];
  const flush = (): void => {
    if (group.length)
      rows.push({
        kind: "tools",
        key: JSON.stringify(group.map((execution) => execution.key)),
        executions: group,
        sourceCount: group.length,
      });
    group = [];
  };
  for (const entry of entries) {
    if (entry.kind === "tool") group.push(entry.execution);
    else {
      flush();
      rows.push(entry);
    }
  }
  flush();
  return rows;
}

function metadataForTool(execution: ToolExecution): string {
  const values: unknown[] = [
    execution.subject?.topic,
    execution.subject?.model,
    execution.subject?.tool?.native_id,
    execution.subject?.tool?.category,
    execution.subject?.tool?.path,
    execution.subject?.tool?.command,
    ...(execution.subject?.tool?.paths ?? []),
  ];
  for (const event of execution.events) {
    values.push(event.kind, event.event_id, event.subject_node_id, event.source_stream_id);
    for (const link of event.links ?? [])
      values.push(link.relation, link.evidence, link.owner_id, link.source_request_id);
  }
  return values
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
}

function matches(entry: InspectionEntry, query: string): boolean {
  if (entry.kind === "tool") return metadataForTool(entry.execution).includes(query);
  if (entry.kind === "activity") {
    return [
      entry.event.kind,
      entry.event.event_id,
      entry.event.source_stream_id,
      entry.event.subject_node_id,
      ...(entry.event.links ?? []).flatMap((link) => [
        link.relation,
        link.evidence,
        link.owner_id,
        link.source_request_id,
      ]),
    ]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLocaleLowerCase()
      .includes(query);
  }
  return [entry.call.call_id, entry.call.source_request_id, entry.call.source_stream_id, entry.call.model]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

function metricSorted(
  owner: NodeOut,
  entries: InspectionEntry[],
  order: SequenceOrder,
  descending: boolean,
): InspectionEntry[] {
  const calls = entries.filter((entry): entry is Extract<InspectionEntry, { kind: "call" }> => entry.kind === "call");
  const bundles = calls.map((call) => ({ call, entries: [call] as InspectionEntry[] }));
  const leading: InspectionEntry[] = [];
  const callsByRequest = new Map<string, number[]>();
  calls.forEach((call, index) => {
    const id = call.call.source_request_id;
    if (id) callsByRequest.set(id, [...(callsByRequest.get(id) ?? []), index]);
  });
  const requestForTool = (entry: InspectionEntry): number | null => {
    if (entry.kind !== "tool") return null;
    const ids = new Set(
      entry.execution.events.flatMap((event) =>
        (event.links ?? [])
          .filter(
            (link) =>
              link.relation === "requested_by" && link.evidence === "recorded" && link.owner_id === owner.node_id,
          )
          .map((link) => link.source_request_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    if (ids.size !== 1) return null;
    const matches = [...ids].flatMap((id) => callsByRequest.get(id) ?? []);
    const unique = [...new Set(matches)];
    return unique.length === 1 ? unique[0] : null;
  };
  let precedingCall: number | null = null;
  for (const entry of [...entries].sort(compareEntries)) {
    if (entry.kind === "call") {
      if (time(entry) !== null) precedingCall = calls.findIndex((call) => call.originalIndex === entry.originalIndex);
      continue;
    }
    const target = requestForTool(entry) ?? (time(entry) !== null ? precedingCall : null);
    if (target !== null && target !== undefined && target >= 0) bundles[target].entries.push(entry);
    else leading.push(entry);
  }
  const value = (call: InspectionEntry): number | null =>
    call.kind === "call" ? callSortValue(call.call, order) : null;
  bundles.sort((a, b) => {
    const av = value(a.call);
    const bv = value(b.call);
    if (av === null && bv !== null) return 1;
    if (av !== null && bv === null) return -1;
    if (av !== null && bv !== null && av !== bv) return (av - bv) * (descending ? -1 : 1);
    return compareEntries(a.call, b.call);
  });
  return [...leading.sort(compareEntries), ...bundles.flatMap((bundle) => bundle.entries.sort(compareEntries))];
}

export function inspectionRows(
  owner: NodeOut,
  root: NodeOut,
  query: string,
  order: SequenceOrder,
  descending: boolean,
): InspectionRow[] {
  let entries = inspectionEntries(owner, root);
  if (order === "chronological") entries.sort(compareEntries);
  else entries = metricSorted(owner, entries, order, descending);
  const rows = groupToolRows(entries);
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return rows;
  const filtered: InspectionRow[] = [];
  for (const row of rows) {
    if (row.kind === "tools") {
      const executions = row.executions.filter((execution) => metadataForTool(execution).includes(needle));
      if (executions.length > 0) filtered.push({ ...row, executions });
    } else if (matches(row, needle)) {
      filtered.push(row);
    }
  }
  return filtered;
}
