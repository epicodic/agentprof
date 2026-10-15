// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { useCallback, useEffect, useRef, useState } from "react";
import type { Location, SetURLSearchParams } from "react-router";
import type { NodeOut } from "../api/types";
import type { InspectionRequest } from "../components/SessionInteraction";
import { type EntityRef, resolveEntity } from "../lib/entities";
import { detailLink } from "../lib/inspectionActions";
import {
  type DetailTab,
  detailTab,
  type InspectionLocation,
  markEntityTransition,
  writeInspection,
} from "../lib/inspectionLocation";
import { preserveSafeLocalMark } from "../lib/localMarks";
import { findNode } from "../lib/tree";
import { writeWorkflowLocation } from "../lib/workflowLocation";
import type { ActivityFilter } from "../lib/workflowState";
import type { RevealRequestOptions } from "./useRevealRequests";

/** What the session page gets from `useInspectionNavigation`. */
export interface InspectionNavigation {
  localMark: { viewKey: string; key: string } | null;
  clipboardError: boolean;
  currentParams: () => URLSearchParams;
  navigateWorkflow: (next: { scopeId?: string | null; activity?: ActivityFilter }, replace: boolean) => void;
  selectEntity: (ref: EntityRef) => void;
  markLocal: (viewKey: string, key: string) => void;
  openEntity: (ref: EntityRef, expandCall?: boolean, destinationTab?: DetailTab) => void;
  openNode: (nodeId: string) => void;
  changeTab: (tab: DetailTab) => void;
  closeDetails: () => void;
  clearSelection: () => void;
  copyLink: (ref: EntityRef) => void;
}

/** URL navigation and the entity actions (select, mark, open, change tab, close, copy link) of the session page. */
export function useInspectionNavigation(options: {
  sessionId: string;
  root: NodeOut;
  location: InspectionLocation;
  selectedNode: NodeOut | null;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  routerLocation: Location;
  memory: Map<string, unknown>;
  pauseFollow: () => void;
  saveSnapshot: () => void;
  keepReplaceBaseline: () => void;
  rememberCurrentTab: () => void;
  setInspectionRequest: (request: InspectionRequest | null) => void;
  commitReveal: (request: RevealRequestOptions) => void;
  queueReveal: (search: string, request: RevealRequestOptions) => void;
  clearQueuedReveal: () => void;
}): InspectionNavigation {
  const {
    sessionId,
    root,
    location,
    selectedNode,
    searchParams,
    setSearchParams,
    routerLocation,
    memory,
    pauseFollow,
    saveSnapshot,
    keepReplaceBaseline,
    rememberCurrentTab,
    setInspectionRequest,
    commitReveal,
    queueReveal,
    clearQueuedReveal,
  } = options;
  const queryState = useRef({ key: routerLocation.key, params: new URLSearchParams(searchParams) });
  if (queryState.current.key !== routerLocation.key) {
    queryState.current = { key: routerLocation.key, params: new URLSearchParams(searchParams) };
  }
  const [localMark, setLocalMark] = useState<{ viewKey: string; key: string } | null>(null);
  const localMarkRoot = useRef(root);
  const [clipboardError, setClipboardError] = useState(false);

  useEffect(() => {
    if (localMarkRoot.current === root) return;
    const previousRoot = localMarkRoot.current;
    localMarkRoot.current = root;
    setLocalMark((mark) => (mark === null ? null : preserveSafeLocalMark(mark, previousRoot, root)));
  }, [root]);

  const currentParams = useCallback(() => queryState.current.params, []);

  const rememberedTab = useCallback(
    (nodeId: string, kind: string): DetailTab => {
      const remembered = memory.get(`tab:${nodeId}`);
      const tab =
        remembered === "overview" || remembered === "workflow" || remembered === "calls" || remembered === "content"
          ? remembered
          : null;
      return detailTab(kind, tab);
    },
    [memory],
  );

  const navigateWorkflow = useCallback(
    (next: { scopeId?: string | null; activity?: ActivityFilter }, replace: boolean) => {
      pauseFollow();
      saveSnapshot();
      const currentParams = queryState.current.params;
      const nextParams = writeWorkflowLocation(currentParams, next);
      if (nextParams.toString() === currentParams.toString()) return;
      if (replace) keepReplaceBaseline();
      queryState.current.params = new URLSearchParams(nextParams);
      setSearchParams(nextParams, { replace });
    },
    [keepReplaceBaseline, pauseFollow, saveSnapshot, setSearchParams],
  );
  const navigateInspection = useCallback(
    (next: typeof location, replace: boolean, revealRequest?: RevealRequestOptions) => {
      const currentParams = queryState.current.params;
      const currentSearch = writeInspection(currentParams, location).toString();
      const nextParams = writeInspection(currentParams, next);
      const nextSearch = nextParams.toString();
      if (revealRequest !== undefined && nextSearch !== currentSearch) queueReveal(nextSearch, revealRequest);
      else clearQueuedReveal();
      saveSnapshot();
      if (replace) keepReplaceBaseline();
      queryState.current.params = new URLSearchParams(nextParams);
      setSearchParams(nextParams, { replace });
      if (revealRequest !== undefined && nextSearch === currentSearch) commitReveal(revealRequest);
    },
    [clearQueuedReveal, commitReveal, keepReplaceBaseline, location, queueReveal, saveSnapshot, setSearchParams],
  );

  const selectEntity = useCallback(
    (ref: EntityRef) => {
      pauseFollow();
      const entity = resolveEntity(root, sessionId, ref);
      if (entity === null) return;
      const transition = markEntityTransition(location, ref, selectedNode?.kind);
      setLocalMark(null);
      setInspectionRequest(transition.inspectionRequest);
      navigateInspection(transition.location, true);
    },
    [pauseFollow, root, sessionId, location, navigateInspection, selectedNode?.kind, setInspectionRequest],
  );

  const markLocal = useCallback(
    (viewKey: string, key: string) => {
      pauseFollow();
      setLocalMark({ viewKey, key });
      setInspectionRequest(null);
      if (location.selection !== null || location.invalidSelection) {
        navigateInspection({ ...location, selection: null, invalidSelection: false }, true);
      }
    },
    [location, navigateInspection, pauseFollow, setInspectionRequest],
  );

  const openEntity = useCallback(
    (ref: EntityRef, expandCall = true, destinationTab?: DetailTab) => {
      pauseFollow();
      const entity = resolveEntity(root, sessionId, ref);
      if (entity === null) return;
      const shouldExpandCall = destinationTab === "content" ? false : expandCall;
      setLocalMark(null);
      rememberCurrentTab();
      const next = {
        ...location,
        nodeId: entity.node.node_id,
        tab:
          destinationTab ??
          (ref.kind === "transcript"
            ? ("content" as const)
            : ref.kind === "call" || ref.kind === "event"
              ? ("workflow" as const)
              : rememberedTab(entity.node.node_id, entity.node.kind)),
        selection: ref,
        invalidSelection: false,
      };
      navigateInspection(next, false, {
        target: entity.node.node_id,
        expandCall: shouldExpandCall,
        reason: "open",
        ref,
        tab: next.tab,
      });
    },
    [pauseFollow, root, sessionId, location, navigateInspection, rememberCurrentTab, rememberedTab],
  );

  const openNode = useCallback(
    (nodeId: string) => {
      if (findNode(root, nodeId) === null) return;
      const ref: EntityRef = { kind: "node", sessionId: sessionId, nodeId };
      openEntity(ref);
    },
    [root, sessionId, openEntity],
  );

  const changeTab = useCallback(
    (tab: DetailTab) => {
      pauseFollow();
      if (selectedNode !== null) memory.set(`tab:${selectedNode.node_id}`, detailTab(selectedNode.kind, tab));
      navigateInspection({ ...location, tab }, true);
    },
    [location, memory, navigateInspection, pauseFollow, selectedNode],
  );

  const closeDetails = useCallback(() => {
    pauseFollow();
    rememberCurrentTab();
    navigateInspection({ ...location, nodeId: null, tab: null }, true);
  }, [location, navigateInspection, pauseFollow, rememberCurrentTab]);

  const clearSelection = useCallback(() => {
    pauseFollow();
    navigateInspection({ ...location, selection: null, invalidSelection: false }, true);
    setLocalMark(null);
  }, [location, navigateInspection, pauseFollow]);

  const copyLink = useCallback(
    (ref: EntityRef) => {
      const link = detailLink(routerLocation.pathname, searchParams, ref);
      try {
        void navigator.clipboard.writeText(link).then(
          () => setClipboardError(false),
          () => setClipboardError(true),
        );
      } catch {
        setClipboardError(true);
      }
    },
    [routerLocation.pathname, searchParams],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.isContentEditable || active.closest('[role="menu"], [role="dialog"], [role="alertdialog"]') !== null)
      )
        return;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement
      )
        return;
      if (window.getSelection()?.toString()) return;
      if (location.selection !== null || location.invalidSelection || localMark !== null) clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearSelection, localMark, location.invalidSelection, location.selection]);

  return {
    localMark,
    clipboardError,
    currentParams,
    navigateWorkflow,
    selectEntity,
    markLocal,
    openEntity,
    openNode,
    changeTab,
    closeDetails,
    clearSelection,
    copyLink,
  };
}
