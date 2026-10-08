// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { ActionIcon, Badge, Box, Group, Paper, RangeSlider, Stack, Text, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type CSSProperties, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { NodeOut } from "../api/types";
import { type EntityRef, relationsToNodes } from "../lib/entities";
import { formatCost, formatDuration, formatTokens, totalTokens, withProvenance } from "../lib/format";
import { colorForMetric, type MetricScale } from "../lib/metricColor";
import type { Span } from "../lib/timeline";
import { findNode, navigationParentId, rowFindingCount, type TreeRow } from "../lib/tree";
import { captureWorkflowAnchor, restoreWorkflowAnchor, type WorkflowAnchor } from "../lib/workflowReading";
import type { WorkflowObservation } from "../lib/workflowState";
import { ActivityTrack } from "./ActivityTrack";
import { AgentBadge } from "./AgentBadge";
import { AxisLabels } from "./AxisLabels";
import { ContextCell } from "./ContextCell";
import { DetailLink } from "./DetailLink";
import selectionClasses from "./EntitySelection.module.css";
import { type InspectionAction, useInspectionMenuTarget } from "./InspectionMenu";
import { useSessionInteraction } from "./SessionInteraction";
import classes from "./TreeTimeline.module.css";
import { WorkflowStatus } from "./WorkflowStatus";

const KIND_MARKS: Record<string, string> = { turn: "▣", agent: "◆", session: "" };

export interface TreeMetricScales {
  duration: MetricScale | null;
  cost: MetricScale | null;
  tokens: MetricScale | null;
  context: MetricScale | null;
}

interface Props {
  rows: TreeRow[];
  scales: TreeMetricScales;
  view: Span | null;
  origin: number;
  range: [number, number];
  onRange: (range: [number, number]) => void;
  selected: string | null;
  onSelect: (nodeId: string) => void;
  onToggle: (key: string) => void;
  revealVersion: number;
  revealTarget: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  restoringHistory: boolean;
  restorationVersion: number;
  workflowRevealVersion: number;
  workflowRevealTarget: string | null;
  onFocusScope?: (nodeId: string) => void;
  contextOnly?: ReadonlySet<string>;
  observations?: ReadonlyMap<string, WorkflowObservation>;
  absoluteDepths?: ReadonlyMap<string, number>;
  isVisible?: boolean;
  onAnchorChange?: (anchor: WorkflowAnchor) => void;
  restorationAnchor?: WorkflowAnchor | null;
  onPauseFollow?: () => void;
}

function TimelineAxis({ view, origin, range, onRange }: Pick<Props, "view" | "origin" | "range" | "onRange">) {
  if (view === null) {
    return (
      <Text size="xs" c="dimmed">
        no timing
      </Text>
    );
  }
  return (
    <Stack gap={2}>
      <RangeSlider size="xs" min={0} max={100} step={0.5} minRange={1} label={null} value={range} onChange={onRange} />
      <AxisLabels view={view} origin={origin} />
    </Stack>
  );
}

function NodeCells({ node, view, scales }: { node: NodeOut; view: Span | null; scales: TreeMetricScales }) {
  const tokens = totalTokens(node.tokens_total);
  return (
    <>
      <span className={classes.metricCell} data-testid={`tree-agent-${node.node_id}`} style={{ justifySelf: "center" }}>
        {node.agent_id !== null && (
          <AgentBadge agentId={node.agent_id} active={node.active || node.active_descendant} />
        )}
      </span>
      <span className={classes.metricCell}>
        <Text size="xs" c="dimmed" truncate="end">
          {node.model ?? ""}
        </Text>
      </span>
      <span className={classes.metricCell}>
        <Text
          data-testid={`tree-duration-${node.node_id}`}
          size="xs"
          ta="right"
          c={colorForMetric(node.duration.value, scales.duration) ?? "dimmed"}
        >
          {withProvenance(formatDuration(node.duration.value), node.duration)}
        </Text>
      </span>
      <span className={classes.metricCell}>
        <Tooltip
          label={`own ${withProvenance(formatCost(node.cost_own), node.cost_own)}`}
          disabled={node.cost_total.value === null}
        >
          <Text size="xs" ta="right" c={colorForMetric(node.cost_total.usd, scales.cost) ?? "dimmed"}>
            {withProvenance(formatCost(node.cost_total), node.cost_total)}
          </Text>
        </Tooltip>
      </span>
      <span className={classes.metricCell}>
        <Text size="xs" ta="right" c={colorForMetric(tokens, scales.tokens) ?? "dimmed"}>
          {formatTokens(tokens)}
        </Text>
      </span>
      <span className={classes.metricCell}>
        <ContextCell node={node} color={colorForMetric(node.context_peak.value, scales.context)} />
      </span>
      <span className={classes.activityCell}>
        <ActivityTrack node={node} view={view} phoneHitTarget />
      </span>
    </>
  );
}

function TopicCell({
  row,
  onToggle,
  showDetails,
  contextOnly,
  observation,
  isPhone,
}: {
  row: TreeRow;
  onToggle: (key: string) => void;
  showDetails: () => void;
  contextOnly: boolean;
  observation: WorkflowObservation | undefined;
  isPhone: boolean;
}) {
  const interaction = useSessionInteraction();
  const { node } = row;
  const findingCount = rowFindingCount(node);
  return (
    <Group
      className={classes.topic}
      gap={4}
      wrap="nowrap"
      style={{ "--row-indent": `${Math.min(row.depth * 16, 96)}px`, paddingRight: 8, minWidth: 0 } as CSSProperties}
    >
      {row.expandable ? (
        <Box w={isPhone ? 44 : 22} style={{ flexShrink: 0 }}>
          <ActionIcon
            data-testid={`toggle-${row.key}`}
            size="xs"
            variant="subtle"
            aria-label={row.expanded ? "Collapse" : "Expand"}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(row.key);
            }}
          >
            {row.expanded ? "▾" : "▸"}
          </ActionIcon>
        </Box>
      ) : (
        <Box w={22} style={{ flexShrink: 0 }} />
      )}
      <Text size="xs" c="dimmed" w={14} style={{ flexShrink: 0 }}>
        {KIND_MARKS[node.kind] ?? ""}
      </Text>
      <Text size="sm" truncate="end" title={node.topic}>
        <DetailLink
          label={node.topic}
          entityRef={
            interaction === null ? null : { kind: "node", sessionId: interaction.sessionId, nodeId: node.node_id }
          }
          onOpen={showDetails}
        >
          {node.topic}
        </DetailLink>
      </Text>
      <span className={classes.inlineStatus}>
        {contextOnly ? "Context ancestor" : observation !== undefined && <WorkflowStatus observation={observation} />}
      </span>
      {findingCount > 0 && (
        <Badge size="xs" color="orange">
          {findingCount}
        </Badge>
      )}
      {node.success === false && (
        <Badge size="xs" color="red">
          failed
        </Badge>
      )}
    </Group>
  );
}

export function TreeTimeline({
  rows,
  scales,
  view,
  origin,
  range,
  onRange,
  selected,
  onSelect,
  onToggle,
  revealVersion,
  revealTarget,
  scrollRef,
  restoringHistory,
  restorationVersion,
  workflowRevealVersion,
  workflowRevealTarget,
  onFocusScope,
  contextOnly = new Set<string>(),
  observations = new Map<string, WorkflowObservation>(),
  absoluteDepths = new Map<string, number>(),
  isVisible = true,
  onAnchorChange,
  restorationAnchor = null,
  onPauseFollow,
}: Props) {
  const isPhone = useMediaQuery("(max-width: 48em)");
  const rowHeight = isPhone ? 176 : 30;
  const interaction = useSessionInteraction();
  const selectionRoot = interaction?.root ?? null;
  const selectionRef = interaction?.location.selection ?? null;
  const resolvedSelection = interaction?.resolved ?? null;
  const selectionRelations = useMemo(
    () => (selectionRoot === null ? new Map() : relationsToNodes(selectionRoot, selectionRef, resolvedSelection)),
    [selectionRoot, selectionRef, resolvedSelection],
  );
  const menuTarget = useInspectionMenuTarget((target) => {
    if (interaction === null) return [];
    const node = findNode(interaction.root, target.dataset.nodeId ?? "");
    if (node === null) return [];
    const ref: EntityRef = { kind: "node", sessionId: interaction.sessionId, nodeId: node.node_id };
    const actions: InspectionAction[] = [
      { id: "details", label: "Show details", run: () => interaction.openEntity(ref) },
    ];
    const parentId = navigationParentId(interaction.root, node.node_id);
    if (parentId !== null) {
      actions.push({ id: "parent", label: "Show parent agent", run: () => interaction.openNode(parentId) });
    }
    actions.push({ id: "copy", label: "Copy link", run: () => interaction.copyLink(ref) });
    if (onFocusScope !== undefined && node.kind !== "tool") {
      actions.push({ id: "focus-subtree", label: "Focus subtree", run: () => onFocusScope(node.node_id) });
    }
    return actions;
  });
  const handledReveal = useRef(0);
  const handledWorkflowReveal = useRef(0);
  const previousRoot = useRef<NodeOut | null>(selectionRoot);
  const previousKeys = useRef(rows.map((row) => row.key));
  const previousRowHeight = useRef(rowHeight);
  const currentAnchor = useRef<WorkflowAnchor | null>(null);
  const handledRestoration = useRef(0);
  const programmaticScroll = useRef<{ version: number; target: number | null } | null>(null);
  const programmaticScrollVersion = useRef(0);
  const anchorRestoreVersion = useRef(0);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => {
      const row = rows[index];
      if (row === undefined) throw new Error(`Missing tree row at virtual index ${index}`);
      return row.key;
    },
    estimateSize: () => rowHeight,
    overscan: 20,
  });

  const beginProgrammaticScroll = useCallback((target: number | null, waitForScroll = false) => {
    programmaticScrollVersion.current += 1;
    const version = programmaticScrollVersion.current;
    programmaticScroll.current = { version, target };
    if (waitForScroll) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (programmaticScroll.current?.version === version) programmaticScroll.current = null;
      });
    });
  }, []);

  const captureCurrentAnchor = useCallback(() => {
    const element = scrollRef.current;
    if (element === null || rowHeight <= 0) return;
    const anchor = captureWorkflowAnchor(
      rows.map((row) => row.key),
      element.scrollTop,
      rowHeight,
    );
    currentAnchor.current = anchor;
    onAnchorChange?.(anchor);
  }, [onAnchorChange, rowHeight, rows, scrollRef]);

  const targetForIndex = useCallback(
    (index: number): number | null => {
      const element = scrollRef.current;
      if (element === null) return null;
      const top = index * rowHeight;
      const bottom = top + rowHeight;
      if (top < element.scrollTop) return top;
      if (bottom > element.scrollTop + element.clientHeight) return bottom - element.clientHeight;
      return element.scrollTop;
    },
    [rowHeight, scrollRef],
  );

  const shouldWaitForScroll = useCallback(
    (target: number | null) => target !== null && Math.abs((scrollRef.current?.scrollTop ?? 0) - target) > 0.5,
    [scrollRef],
  );

  const restoreCurrentAnchor = useCallback(
    (anchor: WorkflowAnchor): boolean => {
      const element = scrollRef.current;
      if (element === null || rowHeight <= 0) return false;
      virtualizer.measure();
      const target = restoreWorkflowAnchor(
        anchor,
        rows.map((row) => row.key),
        rowHeight,
      );
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      const clamped = Math.min(target, maximum);
      beginProgrammaticScroll(clamped, Math.abs(element.scrollTop - clamped) > 0.5);
      element.scrollTop = clamped;
      const restored = captureWorkflowAnchor(
        rows.map((row) => row.key),
        clamped,
        rowHeight,
      );
      currentAnchor.current = restored;
      onAnchorChange?.(restored);
      return true;
    },
    [beginProgrammaticScroll, onAnchorChange, rowHeight, rows, scrollRef, virtualizer],
  );

  useLayoutEffect(() => {
    if (!isVisible || rowHeight <= 0) return;
    virtualizer.measure();
  }, [isVisible, rowHeight, virtualizer]);

  useLayoutEffect(() => {
    if (!isVisible || restorationVersion === 0 || handledRestoration.current === restorationVersion) return;
    const legacy = interaction?.memory.get("history:tree-scroll-top");
    if (restorationAnchor !== null) {
      const frame = window.requestAnimationFrame(() => {
        if (restoreCurrentAnchor(restorationAnchor)) {
          handledRestoration.current = restorationVersion;
          previousRoot.current = selectionRoot;
          previousRowHeight.current = rowHeight;
          previousKeys.current = rows.map((row) => row.key);
        }
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (typeof legacy === "number" && scrollRef.current !== null) {
      beginProgrammaticScroll(legacy);
      const frame = window.requestAnimationFrame(() => {
        if (scrollRef.current !== null) {
          scrollRef.current.scrollTop = legacy;
          captureCurrentAnchor();
          handledRestoration.current = restorationVersion;
          previousRoot.current = selectionRoot;
          previousRowHeight.current = rowHeight;
          previousKeys.current = rows.map((row) => row.key);
        }
      });
      return () => window.cancelAnimationFrame(frame);
    }
    handledRestoration.current = restorationVersion;
  }, [
    beginProgrammaticScroll,
    captureCurrentAnchor,
    interaction?.memory,
    restoreCurrentAnchor,
    restorationAnchor,
    restorationVersion,
    rowHeight,
    rows,
    scrollRef,
    isVisible,
    selectionRoot,
  ]);

  useLayoutEffect(() => {
    const keys = rows.map((row) => row.key);
    const sourceChanged = previousRoot.current !== selectionRoot;
    const breakpointChanged = previousRowHeight.current !== rowHeight;
    const canRestoreBackground =
      !restoringHistory &&
      handledReveal.current >= revealVersion &&
      handledWorkflowReveal.current >= workflowRevealVersion;
    if (!isVisible) return;
    if (restoringHistory) {
      previousRoot.current = selectionRoot;
      previousRowHeight.current = rowHeight;
      previousKeys.current = keys;
      return;
    }
    if (restorationVersion > handledRestoration.current) return;
    if ((sourceChanged || breakpointChanged) && canRestoreBackground) {
      const element = scrollRef.current;
      const anchor =
        currentAnchor.current ??
        captureWorkflowAnchor(previousKeys.current, element?.scrollTop ?? 0, previousRowHeight.current);
      anchorRestoreVersion.current += 1;
      const version = anchorRestoreVersion.current;
      const frame = window.requestAnimationFrame(() => {
        if (anchorRestoreVersion.current !== version || !restoreCurrentAnchor(anchor)) return;
        previousRoot.current = selectionRoot;
        previousRowHeight.current = rowHeight;
        previousKeys.current = keys;
      });
      return () => window.cancelAnimationFrame(frame);
    }
    previousRoot.current = selectionRoot;
    previousRowHeight.current = rowHeight;
    previousKeys.current = keys;
    if (!sourceChanged && !breakpointChanged) captureCurrentAnchor();
  }, [
    restorationVersion,
    restoringHistory,
    rows,
    rowHeight,
    scrollRef,
    selectionRoot,
    revealVersion,
    workflowRevealVersion,
    isVisible,
    captureCurrentAnchor,
    restoreCurrentAnchor,
  ]);

  useEffect(() => {
    if (
      !isVisible ||
      restoringHistory ||
      revealVersion === 0 ||
      handledReveal.current === revealVersion ||
      revealTarget === null
    )
      return;
    const index = rows.findIndex((row) => row.key === revealTarget);
    if (index < 0) return;
    const scrollTarget = targetForIndex(index);
    beginProgrammaticScroll(scrollTarget, shouldWaitForScroll(scrollTarget));
    virtualizer.scrollToIndex(index, { align: "auto" });
    window.requestAnimationFrame(() => {
      // scrollToIndex may need a layout pass before the browser applies its
      // scroll. Capture the resulting viewport before allowing source anchors
      // to restore over this explicit reveal.
      captureCurrentAnchor();
      if (handledReveal.current < revealVersion) handledReveal.current = revealVersion;
    });
  }, [
    beginProgrammaticScroll,
    captureCurrentAnchor,
    isVisible,
    revealVersion,
    revealTarget,
    restoringHistory,
    rows,
    targetForIndex,
    virtualizer,
    shouldWaitForScroll,
  ]);

  useEffect(() => {
    if (
      restoringHistory ||
      !isVisible ||
      workflowRevealVersion === 0 ||
      handledWorkflowReveal.current === workflowRevealVersion ||
      workflowRevealTarget === null
    )
      return;
    const index = rows.findIndex((row) => row.key === workflowRevealTarget);
    if (index < 0) return;
    const scrollTarget = targetForIndex(index);
    beginProgrammaticScroll(scrollTarget, shouldWaitForScroll(scrollTarget));
    virtualizer.scrollToIndex(index, { align: "auto" });
    window.requestAnimationFrame(() => {
      captureCurrentAnchor();
      if (handledWorkflowReveal.current < workflowRevealVersion) {
        handledWorkflowReveal.current = workflowRevealVersion;
      }
    });
  }, [
    beginProgrammaticScroll,
    captureCurrentAnchor,
    isVisible,
    restoringHistory,
    rows,
    targetForIndex,
    virtualizer,
    workflowRevealTarget,
    workflowRevealVersion,
    shouldWaitForScroll,
  ]);

  return (
    <Paper withBorder role="grid" aria-label="Call tree" aria-rowcount={rows.length + 1} className={classes.tree}>
      <Box className={classes.phoneAxis} role="group" aria-label="Timeline zoom controls">
        <TimelineAxis view={view} origin={origin} range={range} onRange={onRange} />
      </Box>
      <Box className={classes.metricsViewport}>
        <Box className={classes.metricsContent}>
          <Box role="row" px="xs" py={4} className={classes.header}>
            <Text role="columnheader" size="xs" fw={600}>
              Topic
            </Text>
            <Text role="columnheader" size="xs" fw={600}>
              Agent
            </Text>
            <Text role="columnheader" size="xs" fw={600}>
              Model
            </Text>
            <Text role="columnheader" size="xs" fw={600} ta="right">
              Duration
            </Text>
            <Text role="columnheader" size="xs" fw={600} ta="right">
              Cost
            </Text>
            <Text role="columnheader" size="xs" fw={600} ta="right">
              Tokens
            </Text>
            <Text role="columnheader" size="xs" fw={600} ta="right">
              Context
            </Text>
            <Box role="columnheader" px={4}>
              <TimelineAxis view={view} origin={origin} range={range} onRange={onRange} />
            </Box>
          </Box>
          <Box
            ref={scrollRef}
            data-testid="tree-scroll"
            className={classes.rowsScroll}
            onScroll={() => {
              const suppression = programmaticScroll.current;
              if (suppression === null) onPauseFollow?.();
              else if (
                suppression.target !== null &&
                scrollRef.current !== null &&
                Math.abs(scrollRef.current.scrollTop - suppression.target) < 1
              ) {
                programmaticScroll.current = null;
              }
              captureCurrentAnchor();
            }}
            onWheel={() => {
              programmaticScroll.current = null;
              onPauseFollow?.();
            }}
            onTouchStart={() => {
              programmaticScroll.current = null;
              onPauseFollow?.();
            }}
            onPointerDown={() => {
              programmaticScroll.current = null;
              onPauseFollow?.();
            }}
            onKeyDown={(event) => {
              if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
                programmaticScroll.current = null;
                onPauseFollow?.();
              }
            }}
          >
            <Box className={classes.rowsCanvas} style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                const ref: EntityRef | null =
                  interaction === null
                    ? null
                    : { kind: "node", sessionId: interaction.sessionId, nodeId: row.node.node_id };
                const activate = () => {
                  if (ref !== null) interaction?.selectEntity(ref);
                };
                const showDetails = () => {
                  if (ref !== null) interaction?.openEntity(ref);
                  else onSelect(row.key);
                };
                const relation = selectionRelations.get(row.node.node_id) ?? "none";
                const isContextOnly = contextOnly.has(row.node.node_id);
                const selection = isContextOnly && relation !== "exact" ? "none" : relation;
                const observation = observations.get(row.node.node_id);
                return (
                  <Box
                    key={row.key}
                    data-testid={`tree-row-${row.key}`}
                    data-node-id={row.node.node_id}
                    role="row"
                    aria-selected={interaction === null ? row.key === selected : selection === "exact"}
                    data-inspected={row.key === selected ? "true" : "false"}
                    data-selection={selection}
                    data-context-only={isContextOnly ? "true" : "false"}
                    className={`${selectionClasses.item} ${classes.row}`}
                    aria-expanded={row.expandable ? row.expanded : undefined}
                    aria-rowindex={virtualRow.index + 2}
                    tabIndex={0}
                    onClick={activate}
                    {...menuTarget}
                    onKeyDown={(event) => {
                      menuTarget.onKeyDown(event);
                      if (event.defaultPrevented) return;
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter") {
                        activate();
                      } else if (event.key === " ") {
                        event.preventDefault();
                        activate();
                      }
                    }}
                    style={{
                      top: virtualRow.start,
                      height: rowHeight,
                    }}
                  >
                    <TopicCell
                      row={row}
                      onToggle={onToggle}
                      showDetails={showDetails}
                      contextOnly={isContextOnly}
                      observation={observation}
                      isPhone={isPhone}
                    />
                    {isPhone && (
                      <div className={classes.phoneMeta} data-testid={`phone-meta-${row.node.node_id}`}>
                        <span>Depth {absoluteDepths.get(row.node.node_id) ?? row.depth}</span>
                        <span>
                          {observation !== undefined && <WorkflowStatus observation={observation} />}
                          {isContextOnly && <span>Context ancestor</span>}
                        </span>
                      </div>
                    )}
                    {isPhone && (
                      <div className={classes.phoneCosts}>
                        <span>Own cost {withProvenance(formatCost(row.node.cost_own), row.node.cost_own)}</span>
                        <span>Subtree cost {withProvenance(formatCost(row.node.cost_total), row.node.cost_total)}</span>
                      </div>
                    )}
                    <NodeCells node={row.node} view={view} scales={scales} />
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Box>
      </Box>
    </Paper>
  );
}
