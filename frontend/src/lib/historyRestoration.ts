// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { NavigationType } from "react-router";

/** Whether the page is restoring the snapshot of the current history entry. */
export function isRestoringHistory(state: {
  pendingKey: string | null;
  navigationType: `${NavigationType}`;
  key: string;
  lastKey: string;
  hasSnapshot: boolean;
}): boolean {
  return (
    state.pendingKey === state.key ||
    (state.navigationType === "POP" && state.key !== state.lastKey && state.hasSnapshot)
  );
}

/** The router key of a browser history entry's state; React Router's first entry has none and is `"default"`. */
export function historyEntryKey(state: unknown): string {
  const key = typeof state === "object" && state !== null ? (state as { key?: unknown }).key : undefined;
  return typeof key === "string" ? key : "default";
}
