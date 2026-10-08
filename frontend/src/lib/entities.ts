// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { ExecutionEventOut, LlmCallOut, NodeOut } from "../api/types";
import { findNode } from "./tree";

export type EntityRef =
  | { kind: "node"; sessionId: string; nodeId: string }
  | { kind: "call"; sessionId: string; ownerId: string; callKey: string }
  | { kind: "event"; sessionId: string; ownerId: string; eventId: string };
export type CallRef = Extract<EntityRef, { kind: "call" }>;

export type SelectionRelation = "none" | "exact" | "associated";

export interface ResolvedEntity {
  node: NodeOut;
  call: LlmCallOut | null;
  event: ExecutionEventOut | null;
  index: number | null;
}

export function agentNode(root: NodeOut, agentId: number): NodeOut | null {
  if (agentId === 1) return root;
  const visit = (node: NodeOut): NodeOut | null => {
    if (node.kind === "agent" && node.agent_id === agentId) return node;
    for (const child of node.children) {
      const found = visit(child);
      if (found !== null) return found;
    }
    return null;
  };
  return visit(root);
}

export function callRef(sessionId: string, owner: NodeOut, index: number): CallRef | null {
  const call = owner.llm_calls[index];
  if (call === undefined || !Number.isInteger(index) || index < 0) return null;

  if (typeof call.call_id === "string" && call.call_id.length > 0) {
    const matches = owner.llm_calls.filter((candidate) => candidate.call_id === call.call_id).length;
    if (matches !== 1) return null;
    return { kind: "call", sessionId, ownerId: owner.node_id, callKey: `id:${call.call_id}` };
  }

  const start = call.start;
  if (start.provenance !== "exact" || start.value === null || !Number.isFinite(start.value)) return null;
  const matches = owner.llm_calls.filter((candidate) => candidate.start.value === start.value).length;
  if (matches !== 1) return null;
  return { kind: "call", sessionId, ownerId: owner.node_id, callKey: `time:${start.value}` };
}

/** Resolve identities for every call with one pass over the owner's calls. */
export function callRefs(sessionId: string, owner: Pick<NodeOut, "node_id" | "llm_calls">): (CallRef | null)[] {
  const idCounts = new Map<string, number>();
  const timeCounts = new Map<number, number>();
  for (const call of owner.llm_calls) {
    const callId = call.call_id;
    if (typeof callId === "string" && callId.length > 0) {
      idCounts.set(callId, (idCounts.get(callId) ?? 0) + 1);
    }
    const start = call.start;
    if (start.value !== null && Number.isFinite(start.value)) {
      timeCounts.set(start.value, (timeCounts.get(start.value) ?? 0) + 1);
    }
  }
  return owner.llm_calls.map((call) => {
    const callId = call.call_id;
    if (typeof callId === "string" && callId.length > 0) {
      return idCounts.get(callId) === 1
        ? { kind: "call", sessionId, ownerId: owner.node_id, callKey: `id:${callId}` }
        : null;
    }
    const start = call.start;
    return start.provenance === "exact" &&
      start.value !== null &&
      Number.isFinite(start.value) &&
      timeCounts.get(start.value) === 1
      ? { kind: "call", sessionId, ownerId: owner.node_id, callKey: `time:${start.value}` }
      : null;
  });
}

export type EventRef = Extract<EntityRef, { kind: "event" }>;

export function eventRef(sessionId: string, owner: NodeOut, index: number): EventRef | null {
  const events = owner.execution_events ?? [];
  const event = events[index];
  if (event === undefined || !Number.isInteger(index) || index < 0) return null;
  const eventId = event.event_id;
  if (typeof eventId !== "string" || eventId.length === 0) return null;
  let matches = 0;
  for (const candidate of events) if (candidate.event_id === eventId) matches += 1;
  return matches === 1 ? { kind: "event", sessionId, ownerId: owner.node_id, eventId } : null;
}

/** Resolve every event identity with one pass over the owner's events. */
export function eventRefs(
  sessionId: string,
  owner: Pick<NodeOut, "node_id" | "execution_events">,
): (EventRef | null)[] {
  const counts = new Map<string, number>();
  const events = owner.execution_events ?? [];
  for (const event of events) {
    const id = event.event_id;
    if (typeof id === "string" && id.length > 0) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return events.map((event) => {
    const id = event.event_id;
    return typeof id === "string" && id.length > 0 && counts.get(id) === 1
      ? { kind: "event", sessionId, ownerId: owner.node_id, eventId: id }
      : null;
  });
}

export function sameEntity(a: EntityRef | null, b: EntityRef | null): boolean {
  if (a === null || b === null || a.kind !== b.kind || a.sessionId !== b.sessionId) return false;
  if (a.kind === "node" && b.kind === "node") return a.nodeId === b.nodeId;
  if (a.kind === "call" && b.kind === "call") return a.ownerId === b.ownerId && a.callKey === b.callKey;
  return a.kind === "event" && b.kind === "event" && a.ownerId === b.ownerId && a.eventId === b.eventId;
}

export function resolveEntity(root: NodeOut, sessionId: string, ref: EntityRef): ResolvedEntity | null {
  if (ref.sessionId !== sessionId) return null;
  if (ref.kind === "node") {
    const node = findNode(root, ref.nodeId);
    return node === null ? null : { node, call: null, event: null, index: null };
  }

  const node = findNode(root, ref.ownerId);
  if (node === null) return null;
  if (ref.kind === "event") {
    if (ref.eventId.length === 0) return null;
    let matchIndex: number | null = null;
    let matches = 0;
    const events = node.execution_events ?? [];
    for (let index = 0; index < events.length; index += 1) {
      if (events[index].event_id === ref.eventId) {
        matchIndex = index;
        matches += 1;
      }
    }
    if (matches !== 1 || matchIndex === null) return null;
    const candidate = eventRef(sessionId, node, matchIndex);
    return candidate !== null && sameEntity(candidate, ref)
      ? { node, call: null, event: events[matchIndex], index: matchIndex }
      : null;
  }
  if (ref.callKey.startsWith("id:")) {
    const sourceId = ref.callKey.slice(3);
    if (sourceId.length === 0) return null;
    let matchIndex: number | null = null;
    let matches = 0;
    for (let index = 0; index < node.llm_calls.length; index += 1) {
      if (node.llm_calls[index].call_id === sourceId) {
        matchIndex = index;
        matches += 1;
      }
    }
    if (matches !== 1 || matchIndex === null) return null;
    const candidate = callRef(sessionId, node, matchIndex);
    return candidate !== null && sameEntity(candidate, ref)
      ? { node, call: node.llm_calls[matchIndex], event: null, index: matchIndex }
      : null;
  }

  if (!ref.callKey.startsWith("time:")) return null;
  const timestampText = ref.callKey.slice(5);
  const timestamp = Number(timestampText);
  if (!Number.isFinite(timestamp) || String(timestamp) !== timestampText) return null;

  let matchIndex: number | null = null;
  let matches = 0;
  for (let index = 0; index < node.llm_calls.length; index += 1) {
    const call = node.llm_calls[index];
    if (call.start.value === timestamp) {
      matches += 1;
      if (call.start.provenance === "exact") matchIndex = index;
    }
  }
  if (matches !== 1 || matchIndex === null) return null;
  const candidate = callRef(sessionId, node, matchIndex);
  return candidate !== null && sameEntity(candidate, ref)
    ? { node, call: node.llm_calls[matchIndex], event: null, index: matchIndex }
    : null;
}

export function relationToNode(
  root: NodeOut,
  sessionId: string,
  ref: EntityRef | null,
  nodeId: string,
): SelectionRelation {
  if (ref === null) return "none";
  if (ref === null || ref.kind !== "node" || ref.nodeId !== nodeId) return "none";
  return resolveEntity(root, sessionId, ref) === null ? "none" : "exact";
}

/** Compute the exact selected-node relation once for every represented node. */
export function relationsToNodes(
  _root: NodeOut,
  ref: EntityRef | null,
  resolved: ResolvedEntity | null,
): Map<string, SelectionRelation> {
  return ref?.kind === "node" && resolved !== null ? new Map([[ref.nodeId, "exact"]]) : new Map();
}
