// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

/** Return a start offset only when both timestamps are available. */
export function sinceAgentStart(start: number | null, origin: number | null): number | null {
  return start === null || origin === null ? null : start - origin;
}
