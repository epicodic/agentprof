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
