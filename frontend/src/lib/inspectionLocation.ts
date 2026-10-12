// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { EntityRef } from "./entities";

export type DetailTab = "overview" | "workflow" | "calls" | "content";

export interface InspectionLocation {
  nodeId: string | null;
  tab: DetailTab | null;
  selection: EntityRef | null;
  invalidSelection: boolean;
}

export interface MarkEntityTransition {
  location: InspectionLocation;
  inspectionRequest: null;
}

const DETAIL_TABS: readonly DetailTab[] = ["overview", "workflow", "calls", "content"];
const SELECTION_PARAMS = ["sel", "owner", "call", "entity", "event", "entry"] as const;

function isDetailTab(value: string | null): value is DetailTab {
  return value !== null && DETAIL_TABS.includes(value as DetailTab);
}

export function detailTab(kind: string, tab: DetailTab | null): DetailTab {
  if (kind === "tool") return tab === "overview" || tab === "content" ? tab : "content";
  return tab === "calls" ? "workflow" : (tab ?? "overview");
}

/** Mark an entity while keeping the currently inspected panel and clearing explicit inspection work. */
export function markEntityTransition(
  location: InspectionLocation,
  selection: EntityRef,
  inspectedNodeKind?: string,
): MarkEntityTransition {
  const tab =
    selection.kind === "transcript" && location.nodeId !== null && location.tab === null
      ? detailTab(inspectedNodeKind ?? "agent", null)
      : location.tab;
  return {
    location: { ...location, tab, selection, invalidSelection: false },
    inspectionRequest: null,
  };
}

export function parseInspection(sessionId: string, params: URLSearchParams): InspectionLocation {
  const rawTab = params.get("tab");
  const selectorPresent = SELECTION_PARAMS.some((name) => params.has(name));
  const selector = params.get("sel");
  const entity = params.get("entity");
  const owner = params.get("owner");
  const call = params.get("call");
  const event = params.get("event");
  let selection: EntityRef | null = null;

  if (selector === "node" && entity !== null && entity.length > 0) {
    selection = { kind: "node", sessionId, nodeId: entity };
  } else if (selector === "call" && owner !== null && owner.length > 0 && call !== null) {
    if (call.startsWith("id:") && call.length > 3) {
      selection = { kind: "call", sessionId, ownerId: owner, callKey: call };
    } else if (call.startsWith("time:")) {
      const value = call.slice(5);
      const timestamp = Number(value);
      if (value.length > 0 && Number.isFinite(timestamp) && String(timestamp) === value) {
        selection = { kind: "call", sessionId, ownerId: owner, callKey: call };
      }
    }
  } else if (selector === "event" && owner !== null && owner.length > 0 && event !== null && event.length > 0) {
    selection = { kind: "event", sessionId, ownerId: owner, eventId: event };
  } else if (selector === "transcript" && owner !== null && owner.length > 0) {
    const entry = params.get("entry");
    if (entry !== null && entry.length > 0)
      selection = { kind: "transcript", sessionId, ownerId: owner, entryId: entry };
  }

  const nodeId = params.get("node") || null;
  const tab = isDetailTab(rawTab) ? rawTab : selection?.kind === "transcript" && nodeId !== null ? "content" : null;
  return {
    nodeId,
    tab,
    selection,
    invalidSelection: selectorPresent && selection === null,
  };
}

export function writeInspection(params: URLSearchParams, location: InspectionLocation): URLSearchParams {
  const result = new URLSearchParams(params);
  result.delete("node");
  result.delete("tab");
  if (location.nodeId !== null) {
    result.set("node", location.nodeId);
    if (location.tab !== null) result.set("tab", location.tab);
  }

  if (!(location.invalidSelection && location.selection === null)) {
    for (const name of SELECTION_PARAMS) result.delete(name);
    if (location.selection?.kind === "node") {
      result.set("sel", "node");
      result.set("entity", location.selection.nodeId);
    } else if (location.selection?.kind === "call") {
      result.set("sel", "call");
      result.set("owner", location.selection.ownerId);
      result.set("call", location.selection.callKey);
    } else if (location.selection?.kind === "event") {
      result.set("sel", "event");
      result.set("owner", location.selection.ownerId);
      result.set("event", location.selection.eventId);
    } else if (location.selection?.kind === "transcript") {
      result.set("sel", "transcript");
      result.set("owner", location.selection.ownerId);
      result.set("entry", location.selection.entryId);
    }
  }
  return result;
}
