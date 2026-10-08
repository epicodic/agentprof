// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { ExecutionEventOut, NodeOut } from "../api/types";
import { type CallRef, type EntityRef, sameEntity } from "./entities";
import { linkedCallRef } from "./eventRelations";
import { parseInspection, writeInspection } from "./inspectionLocation";

/** Resolve unique recorded requester or consumer calls, preserving their source identity. */
export function recordedCallTargets(
  root: NodeOut,
  sessionId: string,
  events: readonly ExecutionEventOut[],
  relation: "requested_by" | "consumed_by",
): CallRef[] {
  const targets: CallRef[] = [];
  for (const event of events) {
    for (const link of event.links) {
      if (link.relation !== relation || link.evidence !== "recorded") continue;
      const ref = linkedCallRef(root, sessionId, link);
      if (ref !== null && !targets.some((target) => sameEntity(target, ref))) targets.push(ref);
    }
  }
  return targets;
}

/** Build a durable detail URL without mutating the caller's current query parameters. */
export function detailLink(pathname: string, params: URLSearchParams, ref: EntityRef): string {
  const current = parseInspection(ref.sessionId, params);
  const location =
    ref.kind === "node"
      ? { ...current, nodeId: ref.nodeId, selection: ref, invalidSelection: false }
      : { ...current, nodeId: ref.ownerId, tab: "workflow" as const, selection: ref, invalidSelection: false };
  const query = writeInspection(params, location).toString();
  return query.length === 0 ? pathname : `${pathname}?${query}`;
}
