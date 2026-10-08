// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Box } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  type CSSProperties,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigationType, useSearchParams } from "react-router";
import type { SessionOut } from "../api/types";
import { agentNode, type EntityRef, resolveEntity } from "../lib/entities";
import { totalTokens } from "../lib/format";
import { detailLink } from "../lib/inspectionActions";
import { type DetailTab, detailTab, parseInspection, writeInspection } from "../lib/inspectionLocation";
import { preserveSafeLocalMark } from "../lib/localMarks";
import { metricScale } from "../lib/metricColor";
import { initialSplitPercent, splitPercentAfterDrag } from "../lib/splitPane";
import { nodeSpan, zoom } from "../lib/timeline";
import {
  allFindings,
  findNode,
  flattenTree,
  initialExpansion,
  navigationParentId,
  revealKeys,
  rowKeyOf,
  rowNodes,
  sortFindings,
} from "../lib/tree";
import { parseWorkflowLocation, writeWorkflowLocation } from "../lib/workflowLocation";
import { newFollowTarget, type WorkflowAnchor } from "../lib/workflowReading";
import { buildWorkflowIndex, resolveWorkflowScope, workflowAncestors, workflowVisibility } from "../lib/workflowScope";
import type { ActivityFilter, ObservedItem } from "../lib/workflowState";
import { AgentSummaryTable } from "./AgentSummaryTable";
import { FindingsDrawer } from "./FindingsDrawer";
import { InspectionMenuProvider } from "./InspectionMenu";
import { NodeDrawer } from "./NodeDrawer";
import { SessionHeader } from "./SessionHeader";
import { type InspectionRequest, type SessionInteraction, SessionInteractionContext } from "./SessionInteraction";
import classes from "./SessionView.module.css";
import { type TreeMetricScales, TreeTimeline } from "./TreeTimeline";
import { WorkflowBreadcrumbs } from "./WorkflowBreadcrumbs";
import { WorkflowToolbar } from "./WorkflowToolbar";

const SPLIT_STORAGE_KEY = "agentprof:session-workspace-split";

interface HistorySnapshot {
  memory: Map<string, unknown>;
  expanded: string[];
  findingsOnly: boolean;
  range: [number, number];
  treeScrollTop: number;
  workflowAnchor: WorkflowAnchor | null;
  agentPanelScrollTop: number;
  inspectionRequest: InspectionRequest | null;
  mobilePanel: "workflow" | "agents";
  scopeOnly: boolean;
}

export function SessionView({ session, fetchedAtMs }: { session: SessionOut; fetchedAtMs?: number }) {
  const isPhone = useMediaQuery("(max-width: 48em)");
  const root = session.root;
  const [searchParams, setSearchParams] = useSearchParams();
  const routerLocation = useLocation();
  const navigationType = useNavigationType();
  const queryState = useRef({ key: routerLocation.key, params: new URLSearchParams(searchParams) });
  if (queryState.current.key !== routerLocation.key) {
    queryState.current = { key: routerLocation.key, params: new URLSearchParams(searchParams) };
  }
  const location = useMemo(() => parseInspection(session.id, searchParams), [session.id, searchParams]);
  const workflowLocation = useMemo(() => parseWorkflowLocation(searchParams), [searchParams]);
  const workflowIndex = useMemo(() => buildWorkflowIndex(root), [root]);
  const latestObservedAtMs = workflowIndex.items.reduce<number | null>(
    (latest, item) => (item.timeMs === null ? latest : latest === null ? item.timeMs : Math.max(latest, item.timeMs)),
    null,
  );
  const requestedScope = resolveWorkflowScope(workflowIndex, workflowLocation.scopeId);
  const scopeRoot = requestedScope.root;
  const inspectedAncestors = useMemo(
    () => (location.nodeId === null ? [] : workflowAncestors(workflowIndex, location.nodeId)),
    [location.nodeId, workflowIndex],
  );
  const requestedNodeId = location.nodeId;
  const selectedNode = requestedNodeId === null ? null : findNode(root, requestedNodeId);
  const selected = selectedNode?.node_id ?? null;
  const resolved = location.selection === null ? null : resolveEntity(root, session.id, location.selection);
  const selectedWorkflowRow = resolved === null ? null : rowKeyOf(root, resolved.node.node_id);
  const unavailable = location.invalidSelection || (location.selection !== null && resolved === null);
  const memory = useRef(new Map<string, unknown>()).current;
  const historySnapshots = useRef(new Map<string, HistorySnapshot>());
  const lastLocationKey = useRef(routerLocation.key);
  const pendingReplaceBaseline = useRef<HistorySnapshot | null>(null);
  const [restorationPending, setRestorationPending] = useState<string | null>(null);
  const restoringHistory =
    restorationPending === routerLocation.key ||
    (navigationType === "POP" &&
      routerLocation.key !== lastLocationKey.current &&
      historySnapshots.current.has(routerLocation.key));
  const explicitNodeInspection = location.nodeId !== null;
  const initialRevealTarget = explicitNodeInspection ? (resolved?.node.node_id ?? selected ?? null) : null;
  const initialRevealKeys = [
    ...(!explicitNodeInspection || selected === null ? [] : revealKeys(root, selected)),
    ...(!explicitNodeInspection || resolved === null ? [] : revealKeys(root, resolved.node.node_id)),
  ];
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set([...initialExpansion(root), ...initialRevealKeys]),
  );
  const [findingsOnly, setFindingsOnly] = useState(false);
  const [pendingScope, setPendingScope] = useState(workflowLocation.scopeId ?? root.node_id);
  const [mobilePanel, setMobilePanel] = useState<"workflow" | "agents">("workflow");
  const [scopeOnly, setScopeOnly] = useState(false);
  const [workflowRevealVersion, setWorkflowRevealVersion] = useState(0);
  const [workflowRevealTarget, setWorkflowRevealTarget] = useState<string | null>(null);
  const pendingWorkflowReveal = useRef<{ search: string; target: string } | null>(null);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [range, setRange] = useState<[number, number]>([0, 100]);
  const [treePercent, setTreePercent] = useState(() =>
    initialSplitPercent(typeof window === "undefined" ? null : window.localStorage.getItem(SPLIT_STORAGE_KEY)),
  );
  const [bottomOpen, setBottomOpen] = useState(true);
  const [revealVersion, setRevealVersion] = useState(initialRevealTarget === null ? 0 : 1);
  const [revealTarget, setRevealTarget] = useState(initialRevealTarget);
  const [restorationVersion, setRestorationVersion] = useState(0);
  const [inspectionRequest, setInspectionRequest] = useState<InspectionRequest | null>(() =>
    location.nodeId === null || location.selection === null ? null : { ref: location.selection, version: 1 },
  );
  const nextInspectionVersion = useRef(inspectionRequest?.version ?? 0);
  const [localMark, setLocalMark] = useState<{ viewKey: string; key: string } | null>(null);
  const localMarkRoot = useRef(root);
  const [clipboardError, setClipboardError] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const agentPanelScrollRef = useRef<HTMLDivElement>(null);
  const [pendingAgentPanelScroll, setPendingAgentPanelScroll] = useState<number | null>(null);
  const workflowAnchorRef = useRef<WorkflowAnchor | null>(null);
  const [followLatest, setFollowLatest] = useState(false);
  const followLatestRef = useRef(false);
  const previousObservations = useRef<readonly ObservedItem[] | null>(null);
  const [followNote, setFollowNote] = useState<string | null>(null);
  const pendingReveal = useRef<{
    search: string;
    expandCall?: boolean;
    target: string;
    reason: "open" | "reveal";
    ref: EntityRef;
    tab: DetailTab | null;
  } | null>(null);

  const pauseFollow = useCallback(() => {
    followLatestRef.current = false;
    setFollowLatest(false);
    setFollowNote(null);
  }, []);

  const pauseForUserControl = useCallback(
    (event: SyntheticEvent<HTMLElement>) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('[data-testid="follow-latest-toggle"]') !== null) {
        const native = event.nativeEvent;
        const isActivation =
          (native instanceof PointerEvent && native.button === 0) ||
          native instanceof TouchEvent ||
          (native instanceof KeyboardEvent && ["Enter", " "].includes(native.key));
        if (isActivation) return;
      }
      pauseFollow();
    },
    [pauseFollow],
  );

  const updateWorkflowAnchor = useCallback((anchor: WorkflowAnchor) => {
    workflowAnchorRef.current = anchor;
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, String(treePercent));
  }, [treePercent]);

  useEffect(() => {
    if (localMarkRoot.current === root) return;
    const previousRoot = localMarkRoot.current;
    localMarkRoot.current = root;
    setLocalMark((mark) => (mark === null ? null : preserveSafeLocalMark(mark, previousRoot, root)));
  }, [root]);

  const workflowView = useMemo(
    () =>
      workflowVisibility(
        workflowIndex,
        scopeRoot.node_id,
        workflowLocation.invalidActivity ? "all" : workflowLocation.activity,
        findingsOnly,
      ),
    [findingsOnly, scopeRoot.node_id, workflowIndex, workflowLocation.activity, workflowLocation.invalidActivity],
  );
  const selectedOutsideWorkflow =
    resolved !== null && selectedWorkflowRow !== null && !workflowView.visible.has(selectedWorkflowRow);
  const rows = useMemo(
    () => flattenTree(scopeRoot, expanded, workflowView.visible),
    [expanded, scopeRoot, workflowView.visible],
  );
  const workflowPath = useMemo(
    () => workflowAncestors(workflowIndex, scopeRoot.node_id),
    [scopeRoot.node_id, workflowIndex],
  );
  const scopeOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const node of workflowPath) if (node.kind !== "tool") ids.add(node.node_id);
    for (const node of inspectedAncestors) if (node.kind !== "tool") ids.add(node.node_id);
    return [...ids]
      .flatMap((nodeId) => {
        const node = workflowIndex.nodes.get(nodeId);
        return node === undefined ? [] : [{ node, depth: workflowIndex.depths.get(nodeId) ?? 0 }];
      })
      .sort((a, b) => a.depth - b.depth || a.node.topic.localeCompare(b.node.topic));
  }, [inspectedAncestors, workflowIndex, workflowPath]);
  const effectiveScopeId = workflowLocation.scopeId ?? root.node_id;
  const previousEffectiveScope = useRef(effectiveScopeId);
  useEffect(() => {
    if (previousEffectiveScope.current !== effectiveScopeId) {
      previousEffectiveScope.current = effectiveScopeId;
      setPendingScope(effectiveScopeId);
    } else if (!scopeOptions.some(({ node }) => node.node_id === pendingScope)) {
      setPendingScope(effectiveScopeId);
    }
  }, [effectiveScopeId, pendingScope, scopeOptions]);
  const scales = useMemo<TreeMetricScales>(() => {
    const nodes = rowNodes(root);
    return {
      duration: metricScale(nodes.map((node) => node.duration.value)),
      cost: metricScale(nodes.map((node) => node.cost_total.usd)),
      tokens: metricScale(nodes.map((node) => totalTokens(node.tokens_total))),
      context: metricScale(nodes.map((node) => node.context_peak.value)),
    };
  }, [root]);
  const selectedRow = useMemo(() => (selected === null ? null : rowKeyOf(root, selected)), [root, selected]);
  const findings = useMemo(() => sortFindings(allFindings(root)), [root]);
  const span = useMemo(() => nodeSpan(root), [root]);
  const view = span === null ? null : zoom(span, range[0], range[1]);

  const toggle = useCallback(
    (key: string) => {
      pauseFollow();
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    },
    [pauseFollow],
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

  const rememberCurrentTab = useCallback(() => {
    if (selectedNode === null) return;
    memory.set(`tab:${selectedNode.node_id}`, detailTab(selectedNode.kind, location.tab));
  }, [location.tab, memory, selectedNode]);

  const saveSnapshot = useCallback(() => {
    rememberCurrentTab();
    historySnapshots.current.set(routerLocation.key, {
      memory: new Map(memory),
      expanded: [...expanded],
      findingsOnly,
      range: [...range],
      treeScrollTop: treeScrollRef.current?.scrollTop ?? 0,
      workflowAnchor: workflowAnchorRef.current,
      agentPanelScrollTop: agentPanelScrollRef.current?.scrollTop ?? 0,
      inspectionRequest,
      mobilePanel,
      scopeOnly,
    });
  }, [
    expanded,
    findingsOnly,
    inspectionRequest,
    memory,
    mobilePanel,
    range,
    rememberCurrentTab,
    routerLocation.key,
    scopeOnly,
  ]);
  const saveSnapshotRef = useRef(saveSnapshot);
  saveSnapshotRef.current = saveSnapshot;

  const navigateWorkflow = useCallback(
    (next: { scopeId?: string | null; activity?: ActivityFilter }, replace: boolean) => {
      pauseFollow();
      saveSnapshot();
      const currentParams = queryState.current.params;
      const nextParams = writeWorkflowLocation(currentParams, next);
      if (nextParams.toString() === currentParams.toString()) return;
      if (replace && pendingReplaceBaseline.current === null) {
        pendingReplaceBaseline.current = historySnapshots.current.get(routerLocation.key) ?? null;
      }
      queryState.current.params = new URLSearchParams(nextParams);
      setSearchParams(nextParams, { replace });
    },
    [pauseFollow, routerLocation.key, saveSnapshot, setSearchParams],
  );
  const focusScope = useCallback(
    (nodeId: string) => {
      const node = workflowIndex.nodes.get(nodeId);
      if (node === undefined || node.kind === "tool") return;
      const nextScope = nodeId === root.node_id ? null : nodeId;
      const currentParams = queryState.current.params;
      const nextParams = writeWorkflowLocation(currentParams, { scopeId: nextScope });
      const nextSearch = nextParams.toString();
      const unchanged = nextSearch === currentParams.toString();
      setPendingScope(nodeId);
      if (!unchanged) pendingWorkflowReveal.current = { search: nextSearch, target: nodeId };
      navigateWorkflow({ scopeId: nextScope }, false);
      if (unchanged) {
        setExpanded((previous) => new Set([...previous, nodeId]));
        setWorkflowRevealTarget(nodeId);
        setWorkflowRevealVersion((version) => version + 1);
      }
    },
    [navigateWorkflow, root.node_id, workflowIndex],
  );
  const expandMatchingPaths = useCallback(() => {
    pauseFollow();
    const target = rowNodes(scopeRoot).find((node) => workflowView.matches.has(node.node_id));
    if (target === undefined) return;
    const matchingKeys = [...workflowView.matches].flatMap((nodeId) => revealKeys(scopeRoot, nodeId));
    setExpanded((previous) => new Set([...previous, ...matchingKeys]));
    setWorkflowRevealTarget(target.node_id);
    setWorkflowRevealVersion((version) => version + 1);
  }, [pauseFollow, scopeRoot, workflowView.matches]);

  const revealWorkflowOwner = useCallback(
    (ownerId: string) => {
      setExpanded((previous) => new Set([...previous, ...revealKeys(root, ownerId)]));
      setWorkflowRevealTarget(ownerId);
      setWorkflowRevealVersion((version) => version + 1);
    },
    [root],
  );

  const acceptFollowResult = useCallback(
    (result: ReturnType<typeof newFollowTarget>) => {
      if (result.reason === "target" && result.ownerId !== null) {
        setFollowNote(null);
        revealWorkflowOwner(result.ownerId);
      } else if (result.reason === "none") {
        setFollowNote("No new activity in this view");
      } else {
        setFollowNote("Latest activity ordering unavailable");
      }
    },
    [revealWorkflowOwner],
  );

  const setFollowMode = useCallback(
    (enabled: boolean) => {
      followLatestRef.current = enabled;
      setFollowLatest(enabled);
      if (enabled) {
        setFollowNote(null);
        acceptFollowResult(newFollowTarget([], workflowIndex.items, workflowView.matches));
      } else {
        setFollowNote(null);
      }
    },
    [acceptFollowResult, workflowIndex.items, workflowView.matches],
  );

  useEffect(() => {
    const previous = previousObservations.current;
    previousObservations.current = workflowIndex.items;
    if (previous !== null && followLatestRef.current) {
      acceptFollowResult(newFollowTarget(previous, workflowIndex.items, workflowView.matches));
    }
  }, [acceptFollowResult, workflowIndex.items, workflowView.matches]);

  useEffect(() => {
    const saveBeforePop = () => {
      pauseFollow();
      saveSnapshotRef.current();
    };
    window.addEventListener("popstate", saveBeforePop, true);
    return () => window.removeEventListener("popstate", saveBeforePop, true);
  }, [pauseFollow]);

  useEffect(() => {
    if (navigationType === "POP") pauseFollow();
  }, [navigationType, pauseFollow]);

  const requestReveal = useCallback(
    (target: string) => {
      setRevealTarget(target);
      setExpanded((previous) => new Set([...previous, ...revealKeys(root, target)]));
      setRevealVersion((value) => value + 1);
    },
    [root],
  );

  const clearDestinationSequence = useCallback(
    (ref: EntityRef, reason: "open" | "reveal", destinationTab: DetailTab | null, expandCall?: boolean) => {
      if (ref.kind !== "event" && (ref.kind !== "call" || expandCall !== false)) return;
      const owner = findNode(root, ref.ownerId);
      if (owner === null) return;
      const inspected = location.nodeId === null ? null : findNode(root, location.nodeId);
      let tableRole: string;
      if (reason === "open" || inspected?.node_id === owner.node_id) {
        tableRole = owner.kind === "session" ? "calls-root" : "calls";
      } else if (owner.kind === "session") {
        tableRole = "calls-root";
      } else if (inspected?.kind === "session") {
        tableRole =
          owner.kind === "turn"
            ? `${inspected.node_id}:${destinationTab === "workflow" ? "workflow:turn" : "calls:call-turn"}`
            : `${inspected.node_id}:${destinationTab === "calls" ? "calls" : "workflow"}:sub-agent`;
      } else {
        tableRole =
          owner.kind === "turn"
            ? `${inspected?.node_id ?? location.nodeId}:${destinationTab ?? "calls"}:turn`
            : `${inspected?.node_id ?? location.nodeId}:${destinationTab ?? "calls"}:sub-agent`;
      }
      const key = `sequence:${owner.node_id}:${tableRole}`;
      memory.set(key, { query: "", order: "chronological", descending: false });
    },
    [location.nodeId, memory, root],
  );

  const commitReveal = useCallback(
    (request: {
      target: string;
      reason: "open" | "reveal";
      ref: EntityRef;
      tab: DetailTab | null;
      expandCall?: boolean;
    }) => {
      clearDestinationSequence(request.ref, request.reason, request.tab, request.expandCall);
      nextInspectionVersion.current += 1;
      setInspectionRequest({
        ref: request.ref,
        version: nextInspectionVersion.current,
        expandCall: request.expandCall,
      });
      const containingRow = rowKeyOf(root, request.target);
      if (containingRow !== null && workflowView.visible.has(containingRow)) requestReveal(request.target);
    },
    [clearDestinationSequence, requestReveal, root, workflowView.visible],
  );

  const navigateInspection = useCallback(
    (
      next: typeof location,
      replace: boolean,
      revealRequest?: {
        target: string;
        reason: "open" | "reveal";
        ref: EntityRef;
        tab: DetailTab | null;
        expandCall?: boolean;
      },
    ) => {
      const currentParams = queryState.current.params;
      const currentSearch = writeInspection(currentParams, location).toString();
      const nextParams = writeInspection(currentParams, next);
      const nextSearch = nextParams.toString();
      pendingReveal.current =
        revealRequest !== undefined && nextSearch !== currentSearch ? { search: nextSearch, ...revealRequest } : null;
      saveSnapshot();
      if (replace && pendingReplaceBaseline.current === null) {
        pendingReplaceBaseline.current = historySnapshots.current.get(routerLocation.key) ?? null;
      }
      queryState.current.params = new URLSearchParams(nextParams);
      setSearchParams(nextParams, { replace });
      if (revealRequest !== undefined && nextSearch === currentSearch) commitReveal(revealRequest);
    },
    [commitReveal, location, routerLocation.key, saveSnapshot, setSearchParams],
  );

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
    setExpanded((previous) => new Set([...previous, queued.target]));
    setWorkflowRevealTarget(queued.target);
    setWorkflowRevealVersion((version) => version + 1);
  }, [navigationType, searchParams]);

  useLayoutEffect(() => {
    if (restoringHistory) {
      const snapshot = historySnapshots.current.get(routerLocation.key);
      if (snapshot !== undefined) {
        memory.clear();
        for (const [key, value] of snapshot.memory) memory.set(key, value);
        setInspectionRequest(snapshot.inspectionRequest);
        setExpanded(new Set(snapshot.expanded));
        setFindingsOnly(snapshot.findingsOnly);
        setMobilePanel(snapshot.mobilePanel);
        setScopeOnly(snapshot.scopeOnly);
        setRange([...snapshot.range]);
        memory.set("history:tree-scroll-top", snapshot.treeScrollTop);
        workflowAnchorRef.current = snapshot.workflowAnchor;
        setPendingAgentPanelScroll(snapshot.agentPanelScrollTop);
        setRestorationPending(routerLocation.key);
        setRestorationVersion((version) => version + 1);
      }
    } else if (navigationType === "REPLACE" && pendingReplaceBaseline.current !== null) {
      historySnapshots.current.set(routerLocation.key, pendingReplaceBaseline.current);
    }
    pendingReplaceBaseline.current = null;
    lastLocationKey.current = routerLocation.key;
  }, [memory, navigationType, restoringHistory, routerLocation.key]);

  useLayoutEffect(() => {
    if (!restoringHistory) saveSnapshot();
  }, [restoringHistory, saveSnapshot]);

  useEffect(() => {
    if (restorationPending === routerLocation.key && restorationVersion > 0) setRestorationPending(null);
  }, [restorationPending, restorationVersion, routerLocation.key]);

  useEffect(() => {
    const saved = pendingAgentPanelScroll;
    if (saved === null || (isPhone && mobilePanel !== "agents") || (!isPhone && !bottomOpen)) return;
    const frame = window.requestAnimationFrame(() => {
      if (agentPanelScrollRef.current === null) return;
      agentPanelScrollRef.current.scrollTop = saved;
      setPendingAgentPanelScroll(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [bottomOpen, isPhone, mobilePanel, pendingAgentPanelScroll]);

  const selectEntity = useCallback(
    (ref: EntityRef) => {
      pauseFollow();
      const entity = resolveEntity(root, session.id, ref);
      if (entity === null) return;
      const next = { ...location, selection: ref, invalidSelection: false };
      setLocalMark(null);
      setInspectionRequest(null);
      navigateInspection(next, true);
    },
    [pauseFollow, root, session.id, location, navigateInspection],
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
    [location, navigateInspection, pauseFollow],
  );

  const openEntity = useCallback(
    (ref: EntityRef, expandCall = true) => {
      pauseFollow();
      const entity = resolveEntity(root, session.id, ref);
      if (entity === null) return;
      setLocalMark(null);
      rememberCurrentTab();
      const next = {
        ...location,
        nodeId: entity.node.node_id,
        tab:
          ref.kind === "call" || ref.kind === "event"
            ? ("workflow" as const)
            : rememberedTab(entity.node.node_id, entity.node.kind),
        selection: ref,
        invalidSelection: false,
      };
      navigateInspection(next, false, {
        target: entity.node.node_id,
        expandCall,
        reason: "open",
        ref,
        tab: next.tab,
      });
    },
    [pauseFollow, root, session.id, location, navigateInspection, rememberCurrentTab, rememberedTab],
  );

  const openNode = useCallback(
    (nodeId: string) => {
      if (findNode(root, nodeId) === null) return;
      const ref: EntityRef = { kind: "node", sessionId: session.id, nodeId };
      openEntity(ref);
    },
    [root, session.id, openEntity],
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

  const interaction: SessionInteraction = {
    sessionId: session.id,
    root,
    location,
    resolved,
    unavailable,
    revealVersion,
    revealTarget,
    restoringHistory,
    restorationVersion,
    inspectionRequest,
    localMark,
    clipboardError,
    copyLink,
    selectEntity,
    markLocal,
    openEntity,
    openNode,
    changeTab,
    closeDetails,
    clearSelection,
    saveSnapshot,
    memory,
  };

  const reveal = useCallback(
    (nodeId: string) => {
      openNode(nodeId);
      setFindingsOpen(false);
    },
    [openNode],
  );

  const resize = useCallback(
    (clientY: number) => {
      pauseFollow();
      const bounds = workspaceRef.current?.getBoundingClientRect();
      if (bounds === undefined) return;
      setTreePercent(splitPercentAfterDrag(clientY - bounds.top, bounds.height));
    },
    [pauseFollow],
  );

  const changeRange = useCallback(
    (next: [number, number]) => {
      pauseFollow();
      setRange(next);
    },
    [pauseFollow],
  );
  const changeFindingsOnly = useCallback(
    (enabled: boolean) => {
      pauseFollow();
      setFindingsOnly(enabled);
    },
    [pauseFollow],
  );
  const changeMobilePanel = useCallback(
    (panel: "workflow" | "agents") => {
      pauseFollow();
      setMobilePanel(panel);
    },
    [pauseFollow],
  );

  return (
    <InspectionMenuProvider sourceSnapshot={root}>
      <SessionInteractionContext.Provider value={interaction}>
        <Box
          className={classes.page}
          onPointerDownCapture={pauseForUserControl}
          onTouchStartCapture={pauseForUserControl}
          onWheelCapture={pauseForUserControl}
          onChangeCapture={pauseForUserControl}
          onKeyDownCapture={(event) => {
            if (["Tab", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
              pauseForUserControl(event);
            } else if (["Enter", " "].includes(event.key)) {
              pauseForUserControl(event);
            }
          }}
        >
          <Box className={classes.headerArea}>
            <SessionHeader
              session={session}
              fetchedAtMs={fetchedAtMs}
              latestObservedAtMs={latestObservedAtMs}
              findingCount={findings.length}
              findingsOnly={findingsOnly}
              onFindingsOnly={changeFindingsOnly}
              onOpenFindings={() => {
                pauseFollow();
                setFindingsOpen(true);
              }}
            />
            <WorkflowBreadcrumbs
              ancestors={workflowPath}
              label="Workflow ancestry"
              sessionId={session.id}
              onInspect={openNode}
            />
            <WorkflowToolbar
              options={scopeOptions}
              pendingScope={pendingScope}
              activity={workflowLocation.invalidActivity ? "all" : workflowLocation.activity}
              invalidScope={requestedScope.unavailable}
              invalidActivity={workflowLocation.invalidActivity}
              matchCount={workflowView.matches.size}
              onPendingScope={(nodeId) => {
                pauseFollow();
                setPendingScope(nodeId);
              }}
              onFocus={() => focusScope(pendingScope)}
              onWholeSession={() => {
                setPendingScope(root.node_id);
                navigateWorkflow({ scopeId: null }, false);
              }}
              onActivity={(activity) => navigateWorkflow({ activity }, true)}
              onExpandMatches={expandMatchingPaths}
              followLatest={followLatest}
              followNote={followNote}
              onFollowLatest={setFollowMode}
            />
          </Box>
          <Box className={classes.mobilePanels} role="group" aria-label="Workspace panel">
            <button
              type="button"
              aria-pressed={mobilePanel === "workflow"}
              onClick={() => changeMobilePanel("workflow")}
            >
              Workflow
            </button>
            <button type="button" aria-pressed={mobilePanel === "agents"} onClick={() => changeMobilePanel("agents")}>
              Agents
            </button>
          </Box>
          {workflowView.matches.size === 0 && (
            <Box role="status" aria-live="polite">
              No hierarchy rows match these filters.
              {(workflowLocation.invalidActivity || workflowLocation.activity !== "all") && (
                <button type="button" onClick={() => navigateWorkflow({ activity: "all" }, true)}>
                  Clear activity filter
                </button>
              )}
              {findingsOnly && (
                <button type="button" onClick={() => setFindingsOnly(false)}>
                  Turn off findings filter
                </button>
              )}
            </Box>
          )}
          {clipboardError && (
            <Box role="status" aria-live="polite" style={{ fontSize: "var(--mantine-font-size-xs)" }}>
              Unable to copy detail link.
            </Box>
          )}
          {unavailable && (
            <Box role="status" aria-live="polite">
              Selected item unavailable
            </Box>
          )}
          {!unavailable && selectedOutsideWorkflow && (
            <Box role="status" aria-live="polite">
              Selected item is outside this workflow scope or filter
            </Box>
          )}
          <Box
            ref={workspaceRef}
            data-testid="session-workspace"
            data-bottom-open={bottomOpen}
            data-mobile-panel={mobilePanel}
            className={classes.workspace}
            style={{ "--tree-percent": `${treePercent}%` } as CSSProperties}
          >
            <Box className={classes.treePane}>
              <TreeTimeline
                rows={rows}
                scales={scales}
                view={view}
                origin={span?.start ?? 0}
                range={range}
                onRange={changeRange}
                selected={selectedRow}
                onSelect={openNode}
                onToggle={toggle}
                revealVersion={revealVersion}
                revealTarget={revealTarget === null ? null : rowKeyOf(root, revealTarget)}
                scrollRef={treeScrollRef}
                restoringHistory={restoringHistory}
                restorationVersion={restorationVersion}
                workflowRevealVersion={workflowRevealVersion}
                workflowRevealTarget={workflowRevealTarget}
                onAnchorChange={updateWorkflowAnchor}
                restorationAnchor={workflowAnchorRef.current}
                onPauseFollow={pauseFollow}
                onFocusScope={focusScope}
                contextOnly={workflowView.contextOnly}
                observations={workflowIndex.observations}
                absoluteDepths={workflowIndex.depths}
                isVisible={!isPhone || mobilePanel === "workflow"}
              />
            </Box>
            <Box
              className={classes.splitter}
              role="separator"
              aria-label="Resize tree and bottom panel"
              aria-orientation="horizontal"
              aria-valuemin={15}
              aria-valuemax={85}
              aria-valuenow={Math.round(treePercent)}
              tabIndex={bottomOpen ? 0 : -1}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                resize(event.clientY);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientY);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  pauseFollow();
                  setTreePercent((value) => Math.max(15, value - 1));
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  pauseFollow();
                  setTreePercent((value) => Math.min(85, value + 1));
                }
              }}
              style={{ display: bottomOpen ? undefined : "none" }}
            />
            <Box className={classes.agentsPane}>
              <Box ref={agentPanelScrollRef} id="agent-summary-panel" className={classes.agentsContent} p="sm">
                <AgentSummaryTable
                  root={root}
                  workflowIndex={workflowIndex}
                  activityFilter={workflowLocation.invalidActivity ? "all" : workflowLocation.activity}
                  scopeId={requestedScope.unavailable || effectiveScopeId === root.node_id ? null : effectiveScopeId}
                  scopeOnly={scopeOnly}
                  onScopeOnly={(enabled) => {
                    pauseFollow();
                    setScopeOnly(enabled);
                  }}
                  hierarchyMatchCount={workflowView.matches.size}
                  onActivityReset={() => navigateWorkflow({ activity: "all" }, true)}
                  onSelectAgent={(agentId) => {
                    const node = agentNode(root, agentId);
                    if (node !== null) openNode(node.node_id);
                  }}
                />
              </Box>
              <Box
                style={{
                  alignItems: "end",
                  borderTop: "1px solid var(--mantine-color-default-border)",
                  display: "flex",
                }}
              >
                <button
                  className={classes.desktopAgentTab}
                  type="button"
                  aria-controls="agent-summary-panel"
                  aria-expanded={bottomOpen}
                  data-testid="bottom-tab-agent-summary"
                  onClick={() => {
                    pauseFollow();
                    setBottomOpen((open) => !open);
                  }}
                  style={{
                    background: "transparent",
                    border: 0,
                    borderBottom: bottomOpen ? "2px solid var(--mantine-color-blue-filled)" : "2px solid transparent",
                    color: "inherit",
                    cursor: "pointer",
                    font: "inherit",
                    padding: "6px 12px",
                  }}
                >
                  Agent summary
                </button>
              </Box>
            </Box>
          </Box>
          <NodeDrawer
            key={`${selected ?? "none"}:${restorationVersion}`}
            sessionId={session.id}
            node={selectedNode}
            parentId={selected === null ? null : navigationParentId(root, selected)}
            mainAgentStart={root.start.value}
            workflowIndex={workflowIndex}
            onSelect={openNode}
            onClose={closeDetails}
          />
          <FindingsDrawer
            opened={findingsOpen}
            findings={findings}
            root={root}
            onClose={() => {
              pauseFollow();
              setFindingsOpen(false);
            }}
            onReveal={reveal}
          />
        </Box>
      </SessionInteractionContext.Provider>
    </InspectionMenuProvider>
  );
}
