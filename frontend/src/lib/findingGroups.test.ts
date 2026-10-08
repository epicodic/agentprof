// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import type { FindingOut } from "../api/types";
import { cost } from "../test/factories";
import { findingGroups } from "./findingGroups";

const base: FindingOut = {
  heuristic_id: "E4",
  node_id: "u1",
  severity: "warning",
  message: "idle",
  evidence: { event_id: "child" },
  estimated_avoidable_cost: cost(),
};

describe("findingGroups", () => {
  it("groups in first occurrence order while retaining every finding", () => {
    const findings = [
      base,
      { ...base, message: "idle again" },
      { ...base, severity: "info" },
      { ...base, heuristic_id: "W4", message: "command repeated" },
      base,
    ];

    const groups = findingGroups(findings);

    expect(groups.map((group) => group.key)).toEqual(["E4:warning", "E4:info", "W4:warning"]);
    expect(groups[0].items).toEqual([findings[0], findings[1], findings[4]]);
    expect(groups.flatMap((group) => group.items)).toHaveLength(5);
    expect(findingGroups([])).toEqual([]);
  });
});
