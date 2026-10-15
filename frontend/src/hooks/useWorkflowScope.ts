// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { type Dispatch, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeOut } from "../api/types";
import { revealKeys, rowNodes } from "../lib/tree";
import type { TreeRevealAction } from "../lib/treeReveal";
import { writeWorkflowLocation } from "../lib/workflowLocation";
import { scopeChoices, type WorkflowIndex, workflowAncestors } from "../lib/workflowScope";
import type { ActivityFilter } from "../lib/workflowState";

/** The scope picker of the workflow toolbar: the pending choice, the choices, and focusing or expanding a scope. */
export function useWorkflowScope(options: {
  root: NodeOut;
  scopeRoot: NodeOut;
  scopeId: string | null;
  workflowIndex: WorkflowIndex;
  matches: ReadonlySet<string>;
  inspectedNodeId: string | null;
  navigateWorkflow: (next: { scopeId?: string | null; activity?: ActivityFilter }, replace: boolean) => void;
  currentParams: () => URLSearchParams;
  queueWorkflowReveal: (search: string, target: string) => void;
  dispatchTreeReveal: Dispatch<TreeRevealAction>;
  pauseFollow: () => void;
}) {
  const {
    root,
    scopeRoot,
    scopeId,
    workflowIndex,
    matches,
    inspectedNodeId,
    navigateWorkflow,
    currentParams,
    queueWorkflowReveal,
    dispatchTreeReveal,
    pauseFollow,
  } = options;
  const [pendingScope, setPendingScope] = useState(scopeId ?? root.node_id);
  const inspectedAncestors = useMemo(
    () => (inspectedNodeId === null ? [] : workflowAncestors(workflowIndex, inspectedNodeId)),
    [inspectedNodeId, workflowIndex],
  );
  const workflowPath = useMemo(
    () => workflowAncestors(workflowIndex, scopeRoot.node_id),
    [scopeRoot.node_id, workflowIndex],
  );
  const scopeOptions = useMemo(
    () => scopeChoices(workflowIndex, workflowPath, inspectedAncestors),
    [inspectedAncestors, workflowIndex, workflowPath],
  );
  const effectiveScopeId = scopeId ?? root.node_id;
  const previousEffectiveScope = useRef(effectiveScopeId);
  useEffect(() => {
    if (previousEffectiveScope.current !== effectiveScopeId) {
      previousEffectiveScope.current = effectiveScopeId;
      setPendingScope(effectiveScopeId);
    } else if (!scopeOptions.some(({ node }) => node.node_id === pendingScope)) {
      setPendingScope(effectiveScopeId);
    }
  }, [effectiveScopeId, pendingScope, scopeOptions]);

  const focusScope = useCallback(
    (nodeId: string) => {
      const node = workflowIndex.nodes.get(nodeId);
      if (node === undefined || node.kind === "tool") return;
      const nextScope = nodeId === root.node_id ? null : nodeId;
      const params = currentParams();
      const nextParams = writeWorkflowLocation(params, { scopeId: nextScope });
      const nextSearch = nextParams.toString();
      const unchanged = nextSearch === params.toString();
      setPendingScope(nodeId);
      if (!unchanged) queueWorkflowReveal(nextSearch, nodeId);
      navigateWorkflow({ scopeId: nextScope }, false);
      if (unchanged) {
        dispatchTreeReveal({ type: "revealWorkflow", target: nodeId, keys: [nodeId] });
      }
    },
    [currentParams, dispatchTreeReveal, navigateWorkflow, queueWorkflowReveal, root.node_id, workflowIndex],
  );
  const expandMatchingPaths = useCallback(() => {
    pauseFollow();
    const target = rowNodes(scopeRoot).find((node) => matches.has(node.node_id));
    if (target === undefined) return;
    const matchingKeys = [...matches].flatMap((nodeId) => revealKeys(scopeRoot, nodeId));
    dispatchTreeReveal({ type: "revealWorkflow", target: target.node_id, keys: matchingKeys });
  }, [dispatchTreeReveal, matches, pauseFollow, scopeRoot]);

  return {
    pendingScope,
    setPendingScope,
    workflowPath,
    scopeOptions,
    effectiveScopeId,
    focusScope,
    expandMatchingPaths,
  };
}
