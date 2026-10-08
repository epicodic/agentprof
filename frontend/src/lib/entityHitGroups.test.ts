// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import type { EntityRef } from "./entities";
import { groupEntityHits, multiCandidateEntityKeys } from "./entityHitGroups";

const ref = (nodeId: string): EntityRef => ({ kind: "node", sessionId: "s", nodeId });

describe("groupEntityHits", () => {
  it("merges overlapping clipped hits and expands them to the minimum width", () => {
    const hits = [
      { left: 10, width: 1, ref: ref("a"), label: "A" },
      { left: 11, width: 1, ref: ref("b"), label: "B" },
      { left: 50, width: 2, ref: ref("c"), label: "C" },
    ];

    expect(groupEntityHits(hits, 3)).toEqual([
      {
        left: 10,
        width: 4,
        candidates: [
          { ref: ref("a"), label: "A" },
          { ref: ref("b"), label: "B" },
        ],
      },
      { left: 50, width: 3, candidates: [{ ref: ref("c"), label: "C" }] },
    ]);
    expect(hits.map(({ left, width }) => [left, width])).toEqual([
      [10, 1],
      [11, 1],
      [50, 2],
    ]);
  });

  it("keeps touching hits separate when their drawn intervals do not overlap", () => {
    expect(
      groupEntityHits(
        [
          { left: 10, width: 1, ref: ref("a"), label: "A" },
          { left: 11, width: 1, ref: ref("b"), label: "B" },
        ],
        1,
      ),
    ).toHaveLength(2);
  });

  it("clips endpoints to the view, sorts equal positions stably and drops empty hits", () => {
    expect(
      groupEntityHits(
        [
          { left: 99, width: 4, ref: ref("edge"), label: "edge" },
          { left: 5, width: 2, ref: ref("first"), label: "first" },
          { left: 5, width: 2, ref: ref("second"), label: "second" },
          { left: -10, width: 5, ref: ref("empty"), label: "empty" },
        ],
        1,
      ),
    ).toEqual([
      {
        left: 5,
        width: 2,
        candidates: [
          { ref: ref("first"), label: "first" },
          { ref: ref("second"), label: "second" },
        ],
      },
      { left: 99, width: 1, candidates: [{ ref: ref("edge"), label: "edge" }] },
    ]);
    expect(groupEntityHits([], 6)).toEqual([]);
  });
});

it("collects multi-candidate membership with linear reference-key reads", () => {
  let reads = 0;
  const groups = Array.from({ length: 500 }, (_, groupIndex) => ({
    left: groupIndex,
    width: 1,
    candidates: [0, 1].map((candidateIndex) => {
      const nodeId = `${groupIndex}-${candidateIndex}`;
      const candidateRef = {
        kind: "node" as const,
        sessionId: "s",
        get nodeId() {
          reads += 1;
          return nodeId;
        },
      };
      return { ref: candidateRef, label: nodeId };
    }),
  }));

  const keys = multiCandidateEntityKeys(groups);

  expect(keys.size).toBe(1000);
  expect(reads).toBe(1000);
});
