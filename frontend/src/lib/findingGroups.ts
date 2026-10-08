// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { FindingOut } from "../api/types";

export interface FindingGroup {
  key: string;
  heuristicId: string;
  severity: string;
  items: FindingOut[];
}

export function findingKey(finding: FindingOut, index: number): string {
  return `${finding.node_id}:${finding.heuristic_id}:${finding.message}:${index}`;
}

export function findingGroups(findings: FindingOut[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of findings) {
    const key = `${finding.heuristic_id}:${finding.severity}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, heuristicId: finding.heuristic_id, severity: finding.severity, items: [] };
      groups.set(key, group);
    }
    group.items.push(finding);
  }
  return [...groups.values()];
}
