// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { FindingReferenceOut, NodeOut } from "../api/types";
import { type EntityRef, resolveEntity } from "./entities";

/** Build and verify the exact entity address named by finding evidence. */
export function resolveFindingReference(
  root: NodeOut,
  sessionId: string,
  reference: FindingReferenceOut,
): EntityRef | null {
  let ref: EntityRef;
  if (reference.kind === "node") {
    if (reference.owner_id !== reference.key) return null;
    ref = { kind: "node", sessionId, nodeId: reference.key };
  } else if (reference.kind === "call") {
    if (!reference.key.startsWith("id:") && !reference.key.startsWith("time:")) return null;
    ref = { kind: "call", sessionId, ownerId: reference.owner_id, callKey: reference.key };
  } else {
    if (reference.key.length === 0) return null;
    ref = { kind: "event", sessionId, ownerId: reference.owner_id, eventId: reference.key };
  }
  return resolveEntity(root, sessionId, ref) === null ? null : ref;
}
