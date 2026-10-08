// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { EventCallLinkOut, NodeOut } from "../api/types";
import { type CallRef, callRef } from "./entities";
import { findNode } from "./tree";

/** Resolve a recorded event-to-call link only when both sides have stable identities. */
export function linkedCallRef(root: NodeOut, sessionId: string, link: EventCallLinkOut): CallRef | null {
  if (typeof link.owner_id !== "string" || link.owner_id.length === 0) return null;
  if (typeof link.source_request_id !== "string" || link.source_request_id.length === 0) return null;
  const owner = findNode(root, link.owner_id);
  if (owner === null) return null;
  let matchIndex: number | null = null;
  let matches = 0;
  for (let index = 0; index < owner.llm_calls.length; index += 1) {
    if (owner.llm_calls[index].source_request_id === link.source_request_id) {
      matchIndex = index;
      matches += 1;
    }
  }
  return matches === 1 && matchIndex !== null ? callRef(sessionId, owner, matchIndex) : null;
}
