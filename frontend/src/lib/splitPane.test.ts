// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "vitest";
import { initialSplitPercent, splitPercentAfterDrag, stepSplitPercent } from "./splitPane";

test("uses the persisted split when it is within the supported bounds", () => {
  expect(initialSplitPercent("62")).toBe(62);
});

test("uses a 75 percent tree pane when there is no valid persisted split", () => {
  expect(initialSplitPercent("not a number")).toBe(75);
});

test("clamps a drag to leave usable space for both panes", () => {
  expect(splitPercentAfterDrag(20, 1_000)).toBe(15);
  expect(splitPercentAfterDrag(980, 1_000)).toBe(85);
});

test("arrow keys move the split by one percent within 15-85", () => {
  expect(stepSplitPercent(50, "ArrowUp")).toBe(49);
  expect(stepSplitPercent(50, "ArrowDown")).toBe(51);
  expect(stepSplitPercent(15, "ArrowUp")).toBe(15);
  expect(stepSplitPercent(85, "ArrowDown")).toBe(85);
  expect(stepSplitPercent(50, "Enter")).toBeNull();
});
