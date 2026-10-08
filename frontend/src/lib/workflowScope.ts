// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { NodeOut } from "../api/types";
import { isRowNode, rowFindingCount } from "./tree";
import {
  type ActivityFilter,
  type ObservedItem,
  observedItems,
  observeWorkflow,
  type WorkflowObservation,
} from "./workflowState";

export interface WorkflowIndex {
  root: NodeOut;
  depths: Map<string, number>;
  items: readonly ObservedItem[];
  nodes: Map<string, NodeOut>;
  parentIds: Map<string, string | null>;
  observations: Map<string, WorkflowObservation>;
  agentNodeIds: Map<number, string[]>;
  agentObservations: Map<number, WorkflowObservation>;
}

export interface WorkflowScope {
  root: NodeOut;
  unavailable: boolean;
}

export interface WorkflowVisibility {
  matches: Set<string>;
  visible: Set<string>;
  contextOnly: Set<string>;
}

export interface WorkflowLocation {
  scopeId: string | null;
  activity: ActivityFilter;
  invalidActivity: boolean;
}

export function buildWorkflowIndex(root: NodeOut): WorkflowIndex {
  const index: WorkflowIndex = {
    root,
    depths: new Map(),
    items: [],
    nodes: new Map(),
    parentIds: new Map(),
    observations: new Map(),
    agentNodeIds: new Map(),
    agentObservations: new Map(),
  };
  const pending: { node: NodeOut; parentId: string | null; depth: number }[] = [
    { node: root, parentId: null, depth: 0 },
  ];
  const owners: NodeOut[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const { node, parentId, depth } = current;
    index.nodes.set(node.node_id, node);
    index.parentIds.set(node.node_id, parentId);
    index.depths.set(node.node_id, depth);
    if (node.kind !== "tool") owners.push(node);
    if ((node.kind === "turn" || node.kind === "agent") && node.agent_id !== null) {
      const group = index.agentNodeIds.get(node.agent_id) ?? [];
      group.push(node.node_id);
      index.agentNodeIds.set(node.agent_id, group);
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      pending.push({ node: node.children[i], parentId: node.node_id, depth: depth + 1 });
    }
  }
  index.items = observedItems(owners);
  for (const node of index.nodes.values()) index.observations.set(node.node_id, observeWorkflow([node]));
  for (const [agentId, nodeIds] of index.agentNodeIds) {
    const group = nodeIds.flatMap((nodeId) => {
      const node = index.nodes.get(nodeId);
      return node === undefined ? [] : [node];
    });
    index.agentObservations.set(agentId, observeWorkflow(group));
  }
  return index;
}

export function workflowAncestors(index: WorkflowIndex, nodeId: string): NodeOut[] {
  if (!index.nodes.has(nodeId)) return [];
  const path: NodeOut[] = [];
  let currentId: string | null = nodeId;
  while (currentId !== null) {
    const node = index.nodes.get(currentId);
    if (node === undefined) break;
    path.push(node);
    currentId = index.parentIds.get(currentId) ?? null;
  }
  return path.reverse();
}

export function resolveWorkflowScope(index: WorkflowIndex, scopeId: string | null): WorkflowScope {
  if (scopeId === null) return { root: index.root, unavailable: false };
  const node = index.nodes.get(scopeId);
  return node !== undefined && (node.kind === "session" || node.kind === "turn" || node.kind === "agent")
    ? { root: node, unavailable: false }
    : { root: index.root, unavailable: true };
}

export function workflowVisibility(
  index: WorkflowIndex,
  scopeId: string,
  activity: ActivityFilter,
  findingsOnly: boolean,
): WorkflowVisibility {
  const scope = resolveWorkflowScope(index, scopeId).root;
  const matches = new Set<string>();
  const pending = [scope];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || !isRowNode(node)) continue;
    const activityMatches = activity === "all" || index.observations.get(node.node_id)?.status === activity;
    if (activityMatches && (!findingsOnly || rowFindingCount(node) > 0)) matches.add(node.node_id);
    for (let i = node.children.length - 1; i >= 0; i -= 1) pending.push(node.children[i]);
  }

  const visible = new Set<string>();
  for (const match of matches) {
    let currentId: string | null = match;
    while (currentId !== null) {
      const node = index.nodes.get(currentId);
      if (node !== undefined && isRowNode(node)) visible.add(currentId);
      if (currentId === scope.node_id) break;
      currentId = index.parentIds.get(currentId) ?? null;
    }
  }
  return { matches, visible, contextOnly: new Set([...visible].filter((id) => !matches.has(id))) };
}
