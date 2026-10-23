// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { NodeOut } from "../api/types";
import type { EntityRef } from "./entities";
import type { DetailTab } from "./inspectionLocation";
import { findNode } from "./tree";

/** The value written to a sequence table's memory so that the destination table opens unfiltered. */
export const RESET_SEQUENCE = { query: "", order: "chronological", descending: false } as const;

/** The sequence-table memory key reset before revealing `ref`, or `null` when nothing is reset. */
export function destinationSequenceKey(
  root: NodeOut,
  ref: EntityRef,
  reason: "open" | "reveal",
  destinationTab: DetailTab | null,
  expandCall: boolean | undefined,
  inspectedNodeId: string | null,
): string | null {
  if (destinationTab === "content") return null;
  if (ref.kind !== "event" && (ref.kind !== "call" || expandCall !== false)) return null;
  const owner = findNode(root, ref.ownerId);
  if (owner === null) return null;
  const inspected = inspectedNodeId === null ? null : findNode(root, inspectedNodeId);
  let tableRole: string;
  if (reason === "open" || inspected?.node_id === owner.node_id) {
    tableRole = owner.kind === "session" ? "calls-root" : "calls";
  } else if (owner.kind === "session") {
    tableRole = "calls-root";
  } else if (inspected?.kind === "session") {
    tableRole =
      owner.kind === "turn"
        ? `${inspected.node_id}:${destinationTab === "workflow" ? "workflow:turn" : "calls:call-turn"}`
        : `${inspected.node_id}:${destinationTab === "calls" ? "calls" : "workflow"}:sub-agent`;
  } else {
    tableRole =
      owner.kind === "turn"
        ? `${inspected?.node_id ?? inspectedNodeId}:${destinationTab ?? "calls"}:turn`
        : `${inspected?.node_id ?? inspectedNodeId}:${destinationTab ?? "calls"}:sub-agent`;
  }
  return `sequence:${owner.node_id}:${tableRole}`;
}
