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
  parseInspection,
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
  currentLocation: () => InspectionLocation;
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
  flushQueuedReveal: () => void;
  clearQueuedReveal: () => void;
}): InspectionNavigation {
  const {
    sessionId,
    root,
    location,
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
    flushQueuedReveal,
    clearQueuedReveal,
  } = options;
  const queryState = useRef({ key: routerLocation.key, params: new URLSearchParams(searchParams) });
  if (queryState.current.key !== routerLocation.key) {
    queryState.current = { key: routerLocation.key, params: new URLSearchParams(searchParams) };
  }
  const [localMark, setLocalMark] = useState<{ viewKey: string; key: string } | null>(null);
  const localMarkRoot = useRef(root);
  const [clipboardError, setClipboardError] = useState(false);

  // Back/forward changes the URL before the router renders it; follow it so callbacks never navigate from a stale query.
  useEffect(() => {
    const onPopState = () => {
      queryState.current.params = new URLSearchParams(window.location.search);
      clearQueuedReveal();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [clearQueuedReveal]);

  useEffect(() => {
    if (localMarkRoot.current === root) return;
    const previousRoot = localMarkRoot.current;
    localMarkRoot.current = root;
    setLocalMark((mark) => (mark === null ? null : preserveSafeLocalMark(mark, previousRoot, root)));
  }, [root]);

  const currentParams = useCallback(() => queryState.current.params, []);
  // The location of the latest navigation. A router transition can leave `location` (from the render) behind the URL,
  // so callbacks that build the next location start from here instead.
  const currentLocation = useCallback(
    (): InspectionLocation => parseInspection(sessionId, queryState.current.params),
    [sessionId],
  );

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
      const currentSearch = writeInspection(currentParams, currentLocation()).toString();
      const nextParams = writeInspection(currentParams, next);
      const nextSearch = nextParams.toString();
      // A reveal queued by the previous navigation has not seen its URL rendered yet; commit it instead of dropping it.
      flushQueuedReveal();
      if (revealRequest !== undefined && nextSearch !== currentSearch) queueReveal(nextSearch, revealRequest);
      saveSnapshot();
      if (replace) keepReplaceBaseline();
      queryState.current.params = new URLSearchParams(nextParams);
      setSearchParams(nextParams, { replace });
      if (revealRequest !== undefined && nextSearch === currentSearch) commitReveal(revealRequest);
    },
    [commitReveal, currentLocation, flushQueuedReveal, keepReplaceBaseline, queueReveal, saveSnapshot, setSearchParams],
  );

  const selectEntity = useCallback(
    (ref: EntityRef) => {
      pauseFollow();
      const entity = resolveEntity(root, sessionId, ref);
      if (entity === null) return;
      flushQueuedReveal();
      const latest = currentLocation();
      const latestNode = latest.nodeId === null ? null : findNode(root, latest.nodeId);
      const transition = markEntityTransition(latest, ref, latestNode?.kind);
      setLocalMark(null);
      setInspectionRequest(transition.inspectionRequest);
      navigateInspection(transition.location, true);
    },
    [
      flushQueuedReveal,
      pauseFollow,
      root,
      sessionId,
      currentLocation,
      navigateInspection,

      setInspectionRequest,
    ],
  );

  const markLocal = useCallback(
    (viewKey: string, key: string) => {
      pauseFollow();
      flushQueuedReveal();
      setLocalMark({ viewKey, key });
      setInspectionRequest(null);
      const latest = currentLocation();
      if (latest.selection !== null || latest.invalidSelection) {
        navigateInspection({ ...latest, selection: null, invalidSelection: false }, true);
      }
    },
    [currentLocation, flushQueuedReveal, navigateInspection, pauseFollow, setInspectionRequest],
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
        ...currentLocation(),
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
    [pauseFollow, root, sessionId, currentLocation, navigateInspection, rememberCurrentTab, rememberedTab],
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
      const latest = currentLocation();
      const node = latest.nodeId === null ? null : findNode(root, latest.nodeId);
      if (node !== null) memory.set(`tab:${node.node_id}`, detailTab(node.kind, tab));
      navigateInspection({ ...latest, tab }, true);
    },
    [currentLocation, memory, navigateInspection, pauseFollow, root],
  );

  const closeDetails = useCallback(() => {
    pauseFollow();
    rememberCurrentTab();
    navigateInspection({ ...currentLocation(), nodeId: null, tab: null }, true);
  }, [currentLocation, navigateInspection, pauseFollow, rememberCurrentTab]);

  const clearSelection = useCallback(() => {
    pauseFollow();
    navigateInspection({ ...currentLocation(), selection: null, invalidSelection: false }, true);
    setLocalMark(null);
  }, [currentLocation, navigateInspection, pauseFollow]);

  const copyLink = useCallback(
    (ref: EntityRef) => {
      const link = detailLink(routerLocation.pathname, queryState.current.params, ref);
      try {
        void navigator.clipboard.writeText(link).then(
          () => setClipboardError(false),
          () => setClipboardError(true),
        );
      } catch {
        setClipboardError(true);
      }
    },
    [routerLocation.pathname],
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
      const latest = currentLocation();
      if (latest.selection !== null || latest.invalidSelection || localMark !== null) clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearSelection, currentLocation, localMark]);

  return {
    localMark,
    clipboardError,
    currentParams,
    currentLocation,
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
