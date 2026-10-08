// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { FindingOut, NodeOut } from "../api/types";
import { artifacts } from "./artifacts";
import { findingKey } from "./findingGroups";
import { allFindings, sortFindings } from "./tree";

export interface LocalMark {
  viewKey: string;
  key: string;
}

function nodesWithId(root: NodeOut, nodeId: string): NodeOut[] {
  const matches: NodeOut[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (node.node_id === nodeId) matches.push(node);
    stack.push(...node.children);
  }
  return matches;
}

function findingSignature(finding: FindingOut): string {
  return `${finding.node_id}\u0000${finding.heuristic_id}\u0000${finding.message}\u0000${finding.severity}`;
}

/** Preserve only path and finding marks that map uniquely across snapshot replacement. */
export function preserveSafeLocalMark(mark: LocalMark, oldRoot: NodeOut, nextRoot: NodeOut): LocalMark | null {
  if (mark.viewKey.startsWith("artifact:")) {
    const ownerId = mark.viewKey.slice("artifact:".length);
    const previousOwners = nodesWithId(oldRoot, ownerId);
    const nextOwners = nodesWithId(nextRoot, ownerId);
    if (previousOwners.length !== 1 || nextOwners.length !== 1) return null;
    const path = mark.key;
    const previousCount = artifacts(previousOwners[0]).filter((artifact) => artifact.path === path).length;
    const nextCount = artifacts(nextOwners[0]).filter((artifact) => artifact.path === path).length;
    return previousCount === 1 && nextCount === 1 ? mark : null;
  }
  if (mark.viewKey === "session-findings") {
    const previous = sortFindings(allFindings(oldRoot)).map((finding, index) => ({
      finding,
      key: findingKey(finding, index),
    }));
    const marked = previous.filter((item) => item.key === mark.key);
    if (marked.length !== 1) return null;
    const target = findingSignature(marked[0].finding);
    if (previous.filter((item) => findingSignature(item.finding) === target).length !== 1) return null;
    const matches = sortFindings(allFindings(nextRoot))
      .map((finding, index) => ({ finding, key: findingKey(finding, index) }))
      .filter((item) => findingSignature(item.finding) === target);
    return matches.length === 1 ? { viewKey: mark.viewKey, key: matches[0].key } : null;
  }
  return null;
}
