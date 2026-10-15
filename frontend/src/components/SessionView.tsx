// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Box } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useLocation, useNavigationType, useSearchParams } from "react-router";
import type { SessionOut } from "../api/types";
import { useFollowLatest } from "../hooks/useFollowLatest";
import { useHistoryRestoration } from "../hooks/useHistoryRestoration";
import { useInspectionNavigation } from "../hooks/useInspectionNavigation";
import { useRevealRequests } from "../hooks/useRevealRequests";
import { useWorkflowScope } from "../hooks/useWorkflowScope";
import { useWorkspaceSplit } from "../hooks/useWorkspaceSplit";
import { agentNode, resolveEntity } from "../lib/entities";
import { totalTokens } from "../lib/format";
import { detailTab, type InspectionLocation, parseInspection } from "../lib/inspectionLocation";
import { metricScale } from "../lib/metricColor";
import { nodeSpan, zoom } from "../lib/timeline";
import {
  findNode,
  flattenTree,
  initialExpansion,
  navigationParentId,
  rankedFindings,
  revealKeys,
  rowKeyOf,
  rowNodes,
} from "../lib/tree";
import { initialTreeReveal, treeRevealReducer } from "../lib/treeReveal";
import { parseWorkflowLocation } from "../lib/workflowLocation";
import type { WorkflowAnchor } from "../lib/workflowReading";
import { buildWorkflowIndex, resolveWorkflowScope, workflowVisibility } from "../lib/workflowScope";
import { AgentSummaryTable } from "./AgentSummaryTable";
import { FindingsDrawer } from "./FindingsDrawer";
import { InspectionMenuProvider } from "./InspectionMenu";
import { NodeDrawer } from "./NodeDrawer";
import { SessionHeader } from "./SessionHeader";
import { type InspectionRequest, type SessionInteraction, SessionInteractionContext } from "./SessionInteraction";
import { SessionStatusMessages } from "./SessionStatusMessages";
import classes from "./SessionView.module.css";
import { SessionWorkspace } from "./SessionWorkspace";
import { type TreeMetricScales, TreeTimeline } from "./TreeTimeline";
import { WorkflowBreadcrumbs } from "./WorkflowBreadcrumbs";
import { WorkflowToolbar } from "./WorkflowToolbar";

interface HistorySnapshot {
  memory: Map<string, unknown>;
  expanded: string[];
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
  const location = useMemo(() => parseInspection(session.id, searchParams), [session.id, searchParams]);
  const workflowLocation = useMemo(() => parseWorkflowLocation(searchParams), [searchParams]);
  const workflowIndex = useMemo(() => buildWorkflowIndex(root), [root]);
  const latestObservedAtMs = workflowIndex.items.reduce<number | null>(
    (latest, item) => (item.timeMs === null ? latest : latest === null ? item.timeMs : Math.max(latest, item.timeMs)),
    null,
  );
  const requestedScope = resolveWorkflowScope(workflowIndex, workflowLocation.scopeId);
  const scopeRoot = requestedScope.root;
  const requestedNodeId = location.nodeId;
  const selectedNode = requestedNodeId === null ? null : findNode(root, requestedNodeId);
  const selected = selectedNode?.node_id ?? null;
  const resolved = location.selection === null ? null : resolveEntity(root, session.id, location.selection);
  const selectedWorkflowRow = resolved === null ? null : rowKeyOf(root, resolved.node.node_id);
  const unavailable = location.invalidSelection || (location.selection !== null && resolved === null);
  const memory = useRef(new Map<string, unknown>()).current;
  const explicitNodeInspection = location.nodeId !== null;
  const initialRevealTarget = explicitNodeInspection ? (resolved?.node.node_id ?? selected ?? null) : null;
  const initialRevealKeys = [
    ...(!explicitNodeInspection || selected === null ? [] : revealKeys(root, selected)),
    ...(!explicitNodeInspection || resolved === null ? [] : revealKeys(root, resolved.node.node_id)),
  ];
  const [treeReveal, dispatchTreeReveal] = useReducer(treeRevealReducer, undefined, () =>
    initialTreeReveal([...initialExpansion(root), ...initialRevealKeys], initialRevealTarget),
  );
  const expanded = treeReveal.expanded;
  const [mobilePanel, setMobilePanel] = useState<"workflow" | "agents">("workflow");
  const [scopeOnly, setScopeOnly] = useState(false);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [range, setRange] = useState<[number, number]>([0, 100]);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [inspectionRequest, setInspectionRequest] = useState<InspectionRequest | null>(() =>
    location.nodeId === null || location.selection === null ? null : { ref: location.selection, version: 1 },
  );
  const nextInspectionVersion = useRef(inspectionRequest?.version ?? 0);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const agentPanelScrollRef = useRef<HTMLDivElement>(null);
  const [pendingAgentPanelScroll, setPendingAgentPanelScroll] = useState<number | null>(null);
  const workflowAnchorRef = useRef<WorkflowAnchor | null>(null);

  const updateWorkflowAnchor = useCallback((anchor: WorkflowAnchor) => {
    workflowAnchorRef.current = anchor;
  }, []);

  const workflowView = useMemo(
    () =>
      workflowVisibility(
        workflowIndex,
        scopeRoot.node_id,
        workflowLocation.invalidActivity ? "all" : workflowLocation.activity,
      ),
    [scopeRoot.node_id, workflowIndex, workflowLocation.activity, workflowLocation.invalidActivity],
  );
  const selectedOutsideWorkflow =
    resolved !== null && selectedWorkflowRow !== null && !workflowView.visible.has(selectedWorkflowRow);
  const rows = useMemo(
    () => flattenTree(scopeRoot, expanded, workflowView.visible),
    [expanded, scopeRoot, workflowView.visible],
  );
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
  const findings = useMemo(() => rankedFindings(root), [root]);
  const span = useMemo(() => nodeSpan(root), [root]);
  const view = span === null ? null : zoom(span, range[0], range[1]);

  const revealWorkflowOwner = useCallback(
    (ownerId: string) => {
      dispatchTreeReveal({ type: "revealWorkflow", target: ownerId, keys: revealKeys(root, ownerId) });
    },
    [root],
  );

  const { followLatest, followNote, pauseFollow, pauseForUserControl, setFollowMode } = useFollowLatest({
    items: workflowIndex.items,
    matches: workflowView.matches,
    navigationType,
    onRevealOwner: revealWorkflowOwner,
  });
  const { workspaceRef, treePercent, splitterHandlers } = useWorkspaceSplit(pauseFollow);

  const toggle = useCallback(
    (key: string) => {
      pauseFollow();
      dispatchTreeReveal({ type: "toggle", key });
    },
    [pauseFollow],
  );

  // The navigation hook needs rememberCurrentTab and rememberCurrentTab needs the hook's latest location, so it reads
  // the getter through a ref that is set right after the hook runs.
  const latestLocation = useRef<() => InspectionLocation>(() => location);
  const rememberCurrentTab = useCallback(() => {
    const latest = latestLocation.current();
    const node = latest.nodeId === null ? null : findNode(root, latest.nodeId);
    if (node !== null) memory.set(`tab:${node.node_id}`, detailTab(node.kind, latest.tab));
  }, [memory, root]);

  const capture = useCallback((): HistorySnapshot => {
    rememberCurrentTab();
    return {
      memory: new Map(memory),
      expanded: [...expanded],
      range: [...range],
      treeScrollTop: treeScrollRef.current?.scrollTop ?? 0,
      workflowAnchor: workflowAnchorRef.current,
      agentPanelScrollTop: agentPanelScrollRef.current?.scrollTop ?? 0,
      inspectionRequest,
      mobilePanel,
      scopeOnly,
    };
  }, [expanded, inspectionRequest, memory, mobilePanel, range, rememberCurrentTab, scopeOnly]);
  const applySnapshot = (snapshot: HistorySnapshot) => {
    memory.clear();
    for (const [key, value] of snapshot.memory) memory.set(key, value);
    setInspectionRequest(snapshot.inspectionRequest);
    dispatchTreeReveal({ type: "restore", expanded: snapshot.expanded });
    setMobilePanel(snapshot.mobilePanel);
    setScopeOnly(snapshot.scopeOnly);
    setRange([...snapshot.range]);
    memory.set("history:tree-scroll-top", snapshot.treeScrollTop);
    workflowAnchorRef.current = snapshot.workflowAnchor;
    setPendingAgentPanelScroll(snapshot.agentPanelScrollTop);
  };
  const { restoringHistory, restorationVersion, saveSnapshot, keepReplaceBaseline } = useHistoryRestoration({
    locationKey: routerLocation.key,
    navigationType,
    capture,
    apply: applySnapshot,
    onBeforePop: pauseFollow,
  });

  const { commitReveal, queueReveal, flushQueuedReveal, clearQueuedReveal, queueWorkflowReveal } = useRevealRequests({
    root,
    searchParams,
    navigationType,
    visibleRows: workflowView.visible,
    inspectedNodeId: location.nodeId,
    memory,
    dispatchTreeReveal,
    setInspectionRequest,
    nextInspectionVersion,
  });

  const {
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
  } = useInspectionNavigation({
    sessionId: session.id,
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
  });

  latestLocation.current = currentLocation;

  const {
    pendingScope,
    setPendingScope,
    workflowPath,
    scopeOptions,
    effectiveScopeId,
    focusScope,
    expandMatchingPaths,
  } = useWorkflowScope({
    root,
    scopeRoot,
    scopeId: workflowLocation.scopeId,
    workflowIndex,
    matches: workflowView.matches,
    inspectedNodeId: location.nodeId,
    navigateWorkflow,
    currentParams,
    queueWorkflowReveal,
    dispatchTreeReveal,
    pauseFollow,
  });

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

  const interaction: SessionInteraction = {
    sessionId: session.id,
    root,
    location,
    resolved,
    unavailable,
    revealVersion: treeReveal.tree.version,
    revealTarget: treeReveal.tree.target,
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

  const changeRange = useCallback(
    (next: [number, number]) => {
      pauseFollow();
      setRange(next);
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
          <SessionStatusMessages
            noMatches={workflowView.matches.size === 0}
            activityFiltered={workflowLocation.invalidActivity || workflowLocation.activity !== "all"}
            onClearActivity={() => navigateWorkflow({ activity: "all" }, true)}
            clipboardError={clipboardError}
            unavailable={unavailable}
            selectedOutsideWorkflow={selectedOutsideWorkflow}
          />
          <SessionWorkspace
            workspaceRef={workspaceRef}
            bottomOpen={bottomOpen}
            mobilePanel={mobilePanel}
            treePercent={treePercent}
            splitterHandlers={splitterHandlers}
            agentPanelScrollRef={agentPanelScrollRef}
            onToggleBottom={() => {
              pauseFollow();
              setBottomOpen((open) => !open);
            }}
            tree={
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
                revealVersion={treeReveal.tree.version}
                revealTarget={treeReveal.tree.target === null ? null : rowKeyOf(root, treeReveal.tree.target)}
                scrollRef={treeScrollRef}
                restoringHistory={restoringHistory}
                restorationVersion={restorationVersion}
                workflowRevealVersion={treeReveal.workflow.version}
                workflowRevealTarget={treeReveal.workflow.target}
                onAnchorChange={updateWorkflowAnchor}
                restorationAnchor={workflowAnchorRef.current}
                onPauseFollow={pauseFollow}
                onFocusScope={focusScope}
                contextOnly={workflowView.contextOnly}
                observations={workflowIndex.observations}
                absoluteDepths={workflowIndex.depths}
                isVisible={!isPhone || mobilePanel === "workflow"}
              />
            }
            agentSummary={
              <AgentSummaryTable
                root={root}
                agents={session.agents}
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
            }
          />
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
