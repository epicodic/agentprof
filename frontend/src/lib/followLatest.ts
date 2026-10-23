// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { WorkflowFollowResult } from "./workflowReading";

/** The owner to reveal for a follow result, if any. */
export function followOwner(result: WorkflowFollowResult): string | null {
  return result.reason === "target" && result.ownerId !== null ? result.ownerId : null;
}

/** The note shown next to the follow toggle after a follow result; `null` when an owner was revealed. */
export function followNote(result: WorkflowFollowResult): string | null {
  if (followOwner(result) !== null) return null;
  return result.reason === "none" ? "No new activity in this view" : "Latest activity ordering unavailable";
}
