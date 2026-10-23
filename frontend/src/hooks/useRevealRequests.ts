// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { type Dispatch, type MutableRefObject, useCallback, useLayoutEffect, useRef } from "react";
import type { NavigationType } from "react-router";
import type { NodeOut } from "../api/types";
import type { InspectionRequest } from "../components/SessionInteraction";
import { destinationSequenceKey, RESET_SEQUENCE } from "../lib/destinationSequence";
import type { EntityRef } from "../lib/entities";
import type { DetailTab } from "../lib/inspectionLocation";
import { revealKeys, rowKeyOf } from "../lib/tree";
import type { TreeRevealAction } from "../lib/treeReveal";

export interface RevealRequestOptions {
  target: string;
  reason: "open" | "reveal";
  ref: EntityRef;
  tab: DetailTab | null;
  expandCall?: boolean;
}

/** Reveals queued until the URL matches the navigation that asked for them, then committed in a layout effect. */
export function useRevealRequests(options: {
  root: NodeOut;
  searchParams: URLSearchParams;
  navigationType: NavigationType;
  visibleRows: ReadonlySet<string>;
  inspectedNodeId: string | null;
  memory: Map<string, unknown>;
  dispatchTreeReveal: Dispatch<TreeRevealAction>;
  setInspectionRequest: (request: InspectionRequest) => void;
  nextInspectionVersion: MutableRefObject<number>;
}): {
  commitReveal: (request: RevealRequestOptions) => void;
  queueReveal: (search: string, request: RevealRequestOptions) => void;
  flushQueuedReveal: () => void;
  clearQueuedReveal: () => void;
  queueWorkflowReveal: (search: string, target: string) => void;
} {
  const {
    root,
    searchParams,
    navigationType,
    visibleRows,
    inspectedNodeId,
    memory,
    dispatchTreeReveal,
    setInspectionRequest,
    nextInspectionVersion,
  } = options;
  const pendingWorkflowReveal = useRef<{ search: string; target: string } | null>(null);
  const pendingReveal = useRef<(RevealRequestOptions & { search: string }) | null>(null);

  const commitReveal = useCallback(
    (request: RevealRequestOptions) => {
      const sequenceKey = destinationSequenceKey(
        root,
        request.ref,
        request.reason,
        request.tab,
        request.expandCall,
        inspectedNodeId,
      );
      if (sequenceKey !== null) memory.set(sequenceKey, { ...RESET_SEQUENCE });
      nextInspectionVersion.current += 1;
      setInspectionRequest({
        ref: request.ref,
        version: nextInspectionVersion.current,
        expandCall: request.expandCall,
      });
      const containingRow = rowKeyOf(root, request.target);
      if (containingRow !== null && visibleRows.has(containingRow)) {
        dispatchTreeReveal({ type: "reveal", target: request.target, keys: revealKeys(root, request.target) });
      }
    },
    [dispatchTreeReveal, inspectedNodeId, memory, nextInspectionVersion, root, setInspectionRequest, visibleRows],
  );

  const queueReveal = useCallback((search: string, request: RevealRequestOptions) => {
    pendingReveal.current = { search, ...request };
  }, []);
  const clearQueuedReveal = useCallback(() => {
    pendingReveal.current = null;
  }, []);
  /**
   * Commits and clears a reveal whose URL has not rendered yet, so a newer navigation does not lose it. It commits with
   * render-time root/visibleRows/inspectedNodeId/memory, which is acceptable because the reveal targets a state already navigated to.
   */
  const flushQueuedReveal = useCallback(() => {
    const queued = pendingReveal.current;
    pendingReveal.current = null;
    if (queued !== null) commitReveal(queued);
  }, [commitReveal]);
  const queueWorkflowReveal = useCallback((search: string, target: string) => {
    pendingWorkflowReveal.current = { search, target };
  }, []);

  useLayoutEffect(() => {
    if (navigationType === "POP") {
      pendingReveal.current = null;
      return;
    }
    const queued = pendingReveal.current;
    if (queued === null || searchParams.toString() !== queued.search) return;
    pendingReveal.current = null;
    commitReveal(queued);
  }, [commitReveal, navigationType, searchParams]);

  useLayoutEffect(() => {
    if (navigationType === "POP") {
      pendingWorkflowReveal.current = null;
      return;
    }
    const queued = pendingWorkflowReveal.current;
    if (queued === null) return;
    if (searchParams.toString() !== queued.search) {
      pendingWorkflowReveal.current = null;
      return;
    }
    pendingWorkflowReveal.current = null;
    dispatchTreeReveal({ type: "revealWorkflow", target: queued.target, keys: [queued.target] });
  }, [dispatchTreeReveal, navigationType, searchParams]);

  return { commitReveal, queueReveal, flushQueuedReveal, clearQueuedReveal, queueWorkflowReveal };
}
