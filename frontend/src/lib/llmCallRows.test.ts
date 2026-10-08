// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "vitest";
import { sinceAgentStart } from "./llmCallRows";

test("calculates time since agent start only when both times are known", () => {
  expect(sinceAgentStart(2000, 1000)).toBe(1000);
  expect(sinceAgentStart(null, 1000)).toBeNull();
  expect(sinceAgentStart(2000, null)).toBeNull();
});
