// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "vitest";
import { isRestoringHistory } from "./historyRestoration";

test("a back/forward navigation to a remembered entry restores it", () => {
  const base = {
    pendingKey: null,
    navigationType: "POP" as const,
    key: "k2",
    lastKey: "k1",
    hasSnapshot: true,
  };

  expect(isRestoringHistory(base)).toBe(true);
  expect(isRestoringHistory({ ...base, hasSnapshot: false })).toBe(false);
  expect(isRestoringHistory({ ...base, lastKey: "k2" })).toBe(false);
  expect(isRestoringHistory({ ...base, navigationType: "PUSH" })).toBe(false);
  expect(isRestoringHistory({ ...base, navigationType: "PUSH", pendingKey: "k2" })).toBe(true);
});
