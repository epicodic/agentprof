// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { ExecutionEventOut, MetricOut, NodeOut } from "../api/types";
import type { SequenceEntry } from "./executionSequence";

export interface ToolExecution {
  key: string;
  ownerId: string;
  subject: NodeOut | null;
  events: readonly ExecutionEventOut[];
  sourceEventIndexes: readonly number[];
  anchor: SequenceEntry | null;
  startMs: number | null;
  resultMs: number | null;
  duration: MetricOut;
  success: boolean | null;
  resultRecorded: boolean;
  pairing: "subject" | "native-invocation" | "unpaired" | "node-only";
}

export interface ToolExecutionProjection {
  executions: ToolExecution[];
  byEventIndex: Map<number, ToolExecution>;
  representedToolIds: Set<string>;
}

type Candidate = { event: ExecutionEventOut; index: number; side: "start" | "result" };
const localObjectKeys = new WeakMap<object, string>();
let nextLocalObjectKey = 0;
function localObjectKey(object: object): string {
  let key = localObjectKeys.get(object);
  if (key === undefined) {
    key = `local:${nextLocalObjectKey++}`;
    localObjectKeys.set(object, key);
  }
  return key;
}
const value = (metric: MetricOut | undefined): number | null =>
  typeof metric?.value === "number" && Number.isFinite(metric.value) && metric.value >= 0 ? metric.value : null;

function invocation(event: ExecutionEventOut): string | null {
  const id = event.event_id;
  if (typeof id !== "string") return null;
  const match = /^(?:tool-start|tool-result):(.+)$/.exec(id);
  return match?.[1] || null;
}

function invocationSide(event: ExecutionEventOut): Candidate["side"] | null {
  if (event.kind === "tool_start") return "start";
  if (event.kind === "tool_result") return "result";
  if (event.kind !== "delegation") return null;
  if (event.event_id?.startsWith("tool-start:")) return "start";
  if (event.event_id?.startsWith("tool-result:")) return "result";
  return event.subject_node_id ? "start" : null;
}

function nativeKeyForRows(rows: Candidate[]): string | null {
  const ids = rows.map((row) => invocation(row.event));
  const streams = [...new Set(rows.map((row) => row.event.source_stream_id ?? ""))];
  return ids.length > 0 && ids[0] && ids.every((id) => id === ids[0]) && streams.length === 1
    ? `${streams[0] ? `${encodeURIComponent(streams[0])}:` : ""}${encodeURIComponent(ids[0])}`
    : null;
}

function nodesById(root: NodeOut): Map<string, NodeOut[]> {
  const nodes = new Map<string, NodeOut[]>();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop() as NodeOut;
    nodes.set(node.node_id, [...(nodes.get(node.node_id) ?? []), node]);
    stack.push(...node.children);
  }
  return nodes;
}

export function toolExecutions(owner: NodeOut, root: NodeOut): ToolExecutionProjection {
  const events = owner.execution_events ?? [];
  const candidates: Candidate[] = [];
  events.forEach((event, index) => {
    const side = invocationSide(event);
    if (side !== null && (event.kind !== "delegation" || event.subject_node_id || invocation(event)))
      candidates.push({ event, index, side });
  });
  const nodeIndex = nodesById(root);
  const consumed = new Set<number>();
  const pairs: { rows: Candidate[]; pairing: ToolExecution["pairing"] }[] = [];
  const subjectGroups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const id = candidate.event.subject_node_id;
    if (id) subjectGroups.set(id, [...(subjectGroups.get(id) ?? []), candidate]);
  }
  for (const [id, rows] of subjectGroups) {
    const starts = rows.filter((row) => row.side === "start");
    const results = rows.filter((row) => row.side === "result");
    const resolved = nodeIndex.get(id);
    const startId = starts.length === 1 ? invocation(starts[0].event) : null;
    const resultId = results.length === 1 ? invocation(results[0].event) : null;
    const startStream = starts.length === 1 ? (starts[0].event.source_stream_id ?? "") : "";
    const resultStream = results.length === 1 ? (results[0].event.source_stream_id ?? "") : "";
    const compatibleStream = starts.length < 1 || results.length < 1 || startStream === resultStream;
    if (
      resolved?.length === 1 &&
      starts.length <= 1 &&
      results.length <= 1 &&
      starts.length + results.length > 0 &&
      compatibleStream &&
      !(startId && resultId && startId !== resultId)
    ) {
      const matched = [...starts, ...results];
      pairs.push({ rows: matched, pairing: "subject" });
      matched.forEach((row) => {
        consumed.add(row.index);
      });
    }
  }
  const nativeGroups = new Map<string, Candidate[]>();
  for (const row of candidates) {
    if (consumed.has(row.index)) continue;
    const id = invocation(row.event);
    if (!id) continue;
    const stream = row.event.source_stream_id ?? "";
    const key = `${stream}\u0000${id}`;
    nativeGroups.set(key, [...(nativeGroups.get(key) ?? []), row]);
  }
  for (const rows of nativeGroups.values()) {
    const starts = rows.filter((row) => row.side === "start");
    const results = rows.filter((row) => row.side === "result");
    if (starts.length === 1 && results.length === 1) {
      pairs.push({ rows: [...starts, ...results], pairing: "native-invocation" });
      rows.forEach((row) => {
        consumed.add(row.index);
      });
    }
  }
  for (const row of candidates) if (!consumed.has(row.index)) pairs.push({ rows: [row], pairing: "unpaired" });

  const representedToolIds = new Set<string>();
  const representedSubjects = new Set<NodeOut>();
  const subjectProjectionCounts = new Map<NodeOut, number>();
  const nativeProjectionCounts = new Map<string, number>();
  for (const { rows } of pairs) {
    const ids = [...new Set(rows.map((row) => row.event.subject_node_id).filter((id): id is string => Boolean(id)))];
    const found = ids.length === 1 ? nodeIndex.get(ids[0]) : undefined;
    if (found?.length === 1) subjectProjectionCounts.set(found[0], (subjectProjectionCounts.get(found[0]) ?? 0) + 1);
    const nativeKey = nativeKeyForRows(rows);
    if (nativeKey !== null) nativeProjectionCounts.set(nativeKey, (nativeProjectionCounts.get(nativeKey) ?? 0) + 1);
  }
  const executions: ToolExecution[] = pairs.map(({ rows, pairing }) => {
    const subjectIds = [
      ...new Set(rows.map((row) => row.event.subject_node_id).filter((id): id is string => Boolean(id))),
    ];
    const maybeSubject = subjectIds.length === 1 ? nodeIndex.get(subjectIds[0]) : undefined;
    const subject = maybeSubject?.length === 1 ? maybeSubject[0] : null;
    if (subject) {
      representedToolIds.add(subject.node_id);
      representedSubjects.add(subject);
    }
    const start = rows.find((row) => row.side === "start");
    const result = rows.find((row) => row.side === "result");
    const recordedExecutionStart =
      value(start?.event.execution_start) !== null ? start?.event.execution_start : result?.event.execution_start;
    const startMetric =
      value(start?.event.start) !== null
        ? start?.event.start
        : value(recordedExecutionStart) !== null
          ? recordedExecutionStart
          : start !== undefined
            ? subject?.start
            : undefined;
    const resultMetric = value(result?.event.start) !== null ? result?.event.start : result?.event.execution_end;
    const startMs = value(startMetric);
    const resultMs = value(resultMetric);
    const interval = startMs !== null && resultMs !== null && resultMs >= startMs ? resultMs - startMs : null;
    const durationProvenance =
      startMetric?.provenance === "estimated" || resultMetric?.provenance === "estimated" ? "estimated" : "exact";
    const duration =
      subject && value(subject.duration) !== null
        ? subject.duration
        : {
            value: interval,
            provenance:
              interval === null ? "n/a: incomplete or inconsistent execution timing evidence" : durationProvenance,
          };
    const anchor: SequenceEntry | null = start
      ? { kind: "event", event: start.event, originalIndex: start.index }
      : result
        ? { kind: "event", event: result.event, originalIndex: result.index }
        : null;
    const nativeKey = nativeKeyForRows(rows);
    const key =
      subject && subjectProjectionCounts.get(subject) === 1
        ? `subject:${subject.node_id}`
        : nativeKey !== null && nativeProjectionCounts.get(nativeKey) === 1
          ? `invocation:${nativeKey}`
          : localObjectKey(rows[0].event);
    return {
      key,
      ownerId: owner.node_id,
      subject,
      events: rows.map((row) => row.event),
      sourceEventIndexes: rows.map((row) => row.index),
      anchor,
      startMs,
      resultMs,
      duration,
      success: result ? (result.event.success ?? null) : null,
      resultRecorded: Boolean(result),
      pairing,
    };
  });
  for (const subject of owner.children) {
    if (subject.kind !== "tool" || representedSubjects.has(subject)) continue;
    representedToolIds.add(subject.node_id);
    representedSubjects.add(subject);
    executions.push({
      key: nodeIndex.get(subject.node_id)?.length === 1 ? `subject:${subject.node_id}` : localObjectKey(subject),
      ownerId: owner.node_id,
      subject,
      events: [],
      sourceEventIndexes: [],
      anchor: null,
      startMs: value(subject.start),
      resultMs: value(subject.end),
      duration: subject.duration,
      success: subject.success,
      resultRecorded: false,
      pairing: "node-only",
    });
  }
  const byEventIndex = new Map<number, ToolExecution>();
  for (const execution of executions)
    for (const index of execution.sourceEventIndexes) byEventIndex.set(index, execution);
  return { executions, byEventIndex, representedToolIds };
}

/** Short invocation name for compact rows and groups. */
export function toolExecutionName(execution: ToolExecution): string {
  return (
    execution.subject?.tool?.native_id ?? (execution.events[0]?.kind === "delegation" ? "Agent" : "Tool invocation")
  );
}
