// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { FindingOut, NodeOut } from "../api/types";

export interface TimedChild {
  node: NodeOut;
  /** Start relative to the parent node's start, or `null` if either is unknown. */
  offset: number | null;
}

export interface TreeRow {
  key: string;
  depth: number;
  node: NodeOut;
  expandable: boolean;
  expanded: boolean;
}

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** The session, turns and agents are tree rows; tool calls never are. */
export function isRowNode(node: NodeOut): boolean {
  return node.kind !== "tool";
}

/** Every row node in depth-first order, including collapsed rows; tool subtrees are excluded. */
export function rowNodes(root: NodeOut): NodeOut[] {
  const nodes: NodeOut[] = [];
  const visit = (node: NodeOut): void => {
    if (!isRowNode(node)) return;
    nodes.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return nodes;
}

function rowChildren(node: NodeOut, visible: ReadonlySet<string> | null): NodeOut[] {
  return node.children.filter((child) => isRowNode(child) && (visible === null || visible.has(child.node_id)));
}

/** The visible rows, `root` first; `visible` (if given) limits which nodes may appear. */
export function flattenTree(
  root: NodeOut,
  expanded: ReadonlySet<string>,
  visible: ReadonlySet<string> | null = null,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (node: NodeOut, depth: number): void => {
    const children = rowChildren(node, visible);
    const expandable = children.length > 0;
    const isOpen = expandable && expanded.has(node.node_id);
    rows.push({ key: node.node_id, depth, node, expandable, expanded: isOpen });
    if (isOpen) {
      for (const child of children) visit(child, depth + 1);
    }
  };
  if (visible === null || visible.has(root.node_id)) visit(root, 0);
  return rows;
}

/** The session and the turns with sub-agents start expanded; everything below them starts collapsed. */
export function initialExpansion(root: NodeOut): Set<string> {
  const turns = root.children.filter((child) => rowChildren(child, null).length > 0);
  return new Set([root.node_id, ...turns.map((child) => child.node_id)]);
}

/** The nodes from a child of `root` down to `nodeId`, or `null`. */
export function findPath(root: NodeOut, nodeId: string): NodeOut[] | null {
  for (const child of root.children) {
    if (child.node_id === nodeId) return [child];
    const rest = findPath(child, nodeId);
    if (rest !== null) return [child, ...rest];
  }
  return null;
}

export function findNode(root: NodeOut, nodeId: string): NodeOut | null {
  if (root.node_id === nodeId) return root;
  const path = findPath(root, nodeId);
  return path === null ? null : path[path.length - 1];
}

/** The calling agent of a node, or the session root for a main-agent node or turn. */
export function navigationParentId(root: NodeOut, nodeId: string): string | null {
  if (root.node_id === nodeId) return null;
  const path = findPath(root, nodeId);
  if (path === null) return null;
  const caller = path
    .slice(0, -1)
    .reverse()
    .find((node) => node.kind === "agent");
  return caller?.node_id ?? root.node_id;
}

/** The key of the row that shows `nodeId`: its own, or for a tool call that of its nearest row ancestor. */
export function rowKeyOf(root: NodeOut, nodeId: string): string | null {
  if (nodeId === root.node_id) return root.node_id;
  const rows = (findPath(root, nodeId) ?? []).filter(isRowNode);
  return rows.length === 0 ? null : rows[rows.length - 1].node_id;
}

/** Expansion keys that make the row of `nodeId` visible: the ancestors of that row, the session included. */
export function revealKeys(root: NodeOut, nodeId: string): string[] {
  const row = rowKeyOf(root, nodeId);
  if (row === null || row === root.node_id) return [];
  return [root.node_id, ...(findPath(root, row) ?? []).slice(0, -1).map((node) => node.node_id)];
}

/** Ids of nodes that have findings themselves or below them. */
export function nodesWithFindings(root: NodeOut): Set<string> {
  const keep = new Set<string>();
  const visit = (node: NodeOut): boolean => {
    let hasFindings = node.findings.length > 0;
    for (const child of node.children) {
      if (visit(child)) hasFindings = true;
    }
    if (hasFindings) keep.add(node.node_id);
    return hasFindings;
  };
  visit(root);
  return keep;
}

/** Findings shown on a node's row: its own and those of its direct tool calls. */
export function rowFindingCount(node: NodeOut): number {
  return node.children
    .filter((child) => child.kind === "tool")
    .reduce((sum, child) => sum + child.findings.length, node.findings.length);
}

function timedChildren(node: NodeOut, kind: string): TimedChild[] {
  const origin = node.start.value;
  return node.children
    .filter((child) => child.kind === kind)
    .map((child) => ({
      node: child,
      offset: origin === null || child.start.value === null ? null : child.start.value - origin,
    }));
}

/** The node's direct tool calls in order. */
export function toolCalls(node: NodeOut): TimedChild[] {
  return timedChildren(node, "tool");
}

/** The node's direct sub-agents in order. */
export function subAgents(node: NodeOut): TimedChild[] {
  return timedChildren(node, "agent");
}

/** The session's turns in order. */
export function turns(node: NodeOut): TimedChild[] {
  return timedChildren(node, "turn");
}

export function allFindings(root: NodeOut): FindingOut[] {
  const findings: FindingOut[] = [...root.findings];
  for (const child of root.children) findings.push(...allFindings(child));
  return findings;
}

export function sortFindings(findings: FindingOut[]): FindingOut[] {
  return [...findings].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
      a.heuristic_id.localeCompare(b.heuristic_id),
  );
}

export function countLlmCalls(root: NodeOut): number {
  return root.llm_calls.length + root.children.reduce((sum, child) => sum + countLlmCalls(child), 0);
}

export function countToolCalls(root: NodeOut): number {
  const own = root.kind === "tool" || root.kind === "agent" ? 1 : 0;
  return own + root.children.reduce((sum, child) => sum + countToolCalls(child), 0);
}
