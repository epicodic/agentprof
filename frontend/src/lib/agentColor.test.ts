// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "vitest";
import { agentColor } from "./agentColor";

test("maps agent IDs to stable golden-ratio-separated hues", () => {
  expect(agentColor(1)).toEqual({ hue: 0 });
  expect(agentColor(2).hue).toBeCloseTo(137.507764, 5);
  expect(agentColor(3).hue).toBeCloseTo(275.015528, 5);
  expect(agentColor(2)).toEqual(agentColor(2));
});
