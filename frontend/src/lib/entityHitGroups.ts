// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { EntityRef } from "./entities";

export interface EntityChoice {
  ref: EntityRef;
  label: string;
}

export interface EntityHit {
  left: number;
  width: number;
  ref: EntityRef;
  label: string;
}

export interface EntityHitGroup {
  left: number;
  width: number;
  candidates: { ref: EntityRef; label: string }[];
}

/** Stable entity keys belonging to visually overlapping chooser groups. */
export function multiCandidateEntityKeys(groups: readonly EntityHitGroup[]): Set<string> {
  const keys = new Set<string>();
  for (const group of groups) {
    if (group.candidates.length < 2) continue;
    for (const candidate of group.candidates) {
      const ref = candidate.ref;
      keys.add(
        ref.kind === "node"
          ? `node:${ref.nodeId}`
          : ref.kind === "call"
            ? `call:${ref.ownerId}:${ref.callKey}`
            : `event:${ref.ownerId}:${ref.eventId}`,
      );
    }
  }
  return keys;
}

/** Merge overlapping hit intervals after clipping them to the timeline. */
export function groupEntityHits(hits: EntityHit[], minWidthPct: number): EntityHitGroup[] {
  const minimum = Math.min(100, Math.max(0, minWidthPct));
  const sorted = hits
    .map((hit) => {
      const left = Math.max(0, Math.min(100, hit.left));
      const right = Math.min(100, hit.left + Math.max(hit.width, minimum));
      return { left, right, ref: hit.ref, label: hit.label };
    })
    .filter((hit) => hit.right > hit.left)
    .sort((a, b) => a.left - b.left);
  const groups: EntityHitGroup[] = [];
  for (const hit of sorted) {
    const last = groups.at(-1);
    if (last !== undefined && hit.left < last.left + last.width) {
      const right = Math.max(last.left + last.width, hit.right);
      last.width = right - last.left;
      last.candidates.push({ ref: hit.ref, label: hit.label });
    } else {
      groups.push({ left: hit.left, width: hit.right - hit.left, candidates: [{ ref: hit.ref, label: hit.label }] });
    }
  }
  return groups;
}
