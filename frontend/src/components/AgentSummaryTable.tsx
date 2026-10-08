// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { NativeSelect, Stack, Switch, Table, Text, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { NodeOut } from "../api/types";
import { type AgentSummaryRow, agentSummaryRows } from "../lib/agentSummary";
import { agentNode, callRef, eventRef, relationsToNodes } from "../lib/entities";
import { formatCost, formatDuration, formatTokens, MISSING, truncateTitle, withProvenance } from "../lib/format";
import { colorForMetric, metricScale } from "../lib/metricColor";
import { navigationParentId } from "../lib/tree";
import type { WorkflowIndex } from "../lib/workflowScope";
import { buildWorkflowIndex } from "../lib/workflowScope";
import type { ActivityFilter, ObservedItem, WorkflowObservation } from "../lib/workflowState";
import { AgentBadge } from "./AgentBadge";
import classes from "./AgentSummaryTable.module.css";
import { DetailLink } from "./DetailLink";
import selectionClasses from "./EntitySelection.module.css";
import { type InspectionAction, useInspectionMenuTarget } from "./InspectionMenu";
import { useSessionInteraction } from "./SessionInteraction";
import { WorkflowStatus } from "./WorkflowStatus";

function sortMark(direction: false | "asc" | "desc"): string {
  if (direction === "asc") return " ▲";
  if (direction === "desc") return " ▼";
  return "";
}

function formatCostWithPercent(row: AgentSummaryRow): string {
  const text = withProvenance(formatCost(row.cost), row.cost);
  return row.costPercent === null ? text : `${text} (${Math.round(row.costPercent)}%)`;
}

function metricCell(value: number | null, scale: ReturnType<typeof metricScale>, text: string) {
  return <span style={{ color: colorForMetric(value, scale) ?? undefined }}>{text}</span>;
}

function activityName(item: ObservedItem): string {
  return item.entry.kind === "call"
    ? `LLM call ${item.entry.originalIndex + 1}`
    : item.entry.event.kind.replaceAll("_", " ");
}

function formattedActivityTime(timeMs: number | null | undefined): string | null {
  if (typeof timeMs !== "number" || !Number.isFinite(timeMs) || timeMs <= 0 || timeMs > 8.64e15) return null;
  const date = new Date(timeMs);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(date);
}

function activityTime(item: ObservedItem): string {
  return formattedActivityTime(item.timeMs) ?? "Activity timing unavailable";
}

function agentsInScope(index: WorkflowIndex, scopeId: string | null): Set<number> | null {
  if (scopeId === null) return null;
  const scope = index.nodes.get(scopeId);
  if (scope === undefined) return null;
  const agents = new Set<number>();
  const pending = [scope];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if ((node.kind === "turn" || node.kind === "agent") && node.agent_id !== null) agents.add(node.agent_id);
    pending.push(...node.children);
  }
  return agents;
}

function columns(
  rows: AgentSummaryRow[],
  nodesByAgent: Map<number, NodeOut>,
  observations: Map<number, WorkflowObservation>,
  workflowIndex: WorkflowIndex,
  interaction: ReturnType<typeof useSessionInteraction>,
  onSelectAgent: (agentId: number) => void,
  sessionId: string | null,
): ColumnDef<AgentSummaryRow>[] {
  const durationScale = metricScale(rows.map((row) => row.duration.value));
  const costScale = metricScale(rows.map((row) => row.cost.usd));
  const tokensTotalScale = metricScale(rows.map((row) => row.tokensTotal.value));
  const tokensInputScale = metricScale(rows.map((row) => row.tokensInput.value));
  const tokensOutputScale = metricScale(rows.map((row) => row.tokensOutput.value));
  return [
    {
      id: "agentId",
      accessorFn: (row) => row.agentId,
      header: "Agent",
      cell: (context) => {
        const agentId = context.getValue<number>();
        return <AgentBadge agentId={agentId} active={context.row.original.active} />;
      },
    },
    {
      id: "activity",
      accessorFn: (row) => observations.get(row.agentId)?.status ?? "unknown",
      header: "Activity",
      cell: (context) => (
        <WorkflowStatus
          observation={
            observations.get(context.row.original.agentId) ?? {
              status: "unknown",
              evidence: "unavailable",
              latest: null,
              latestTimedAtMs: null,
              completionRecorded: false,
              taskOwnerId: null,
            }
          }
        />
      ),
    },
    {
      id: "topic",
      accessorFn: (row) => row.topic,
      header: "Topic",
      cell: (context) => {
        const node = nodesByAgent.get(context.row.original.agentId);
        const topic = context.getValue<string>();
        return (
          <Text size="xs" truncate="end" title={context.getValue<string>()} style={{ maxWidth: 320 }}>
            {node === undefined ? (
              <span title={topic}>{truncateTitle(topic)}</span>
            ) : (
              <DetailLink
                label={topic}
                entityRef={
                  interaction === null ? null : { kind: "node", sessionId: interaction.sessionId, nodeId: node.node_id }
                }
                onOpen={() => {
                  if (interaction !== null)
                    interaction.openEntity({ kind: "node", sessionId: interaction.sessionId, nodeId: node.node_id });
                  else onSelectAgent(context.row.original.agentId);
                }}
              >
                {topic}
              </DetailLink>
            )}
          </Text>
        );
      },
    },
    {
      id: "latestActivity",
      accessorFn: (row) => observations.get(row.agentId)?.latestTimedAtMs ?? undefined,
      header: "Latest observed activity",
      sortUndefined: "last",
      cell: (context) => {
        const observation = observations.get(context.row.original.agentId);
        const item = observation?.latest;
        if (item === null || item === undefined) {
          const time = formattedActivityTime(observation?.latestTimedAtMs);
          return (
            <Text size="xs">
              {time === null ? "Activity timing unavailable" : `Latest activity ordering unavailable · ${time}`}
            </Text>
          );
        }
        const owner = workflowIndex.nodes.get(item.ownerId);
        if (owner === undefined) {
          const fullLabel = `${activityName(item)} · ${activityTime(item)}`;
          return (
            <Text size="xs" title={fullLabel}>
              {truncateTitle(fullLabel)}
            </Text>
          );
        }
        const ref =
          interaction === null || sessionId === null
            ? null
            : item.entry.kind === "call"
              ? callRef(sessionId, owner, item.entry.originalIndex)
              : eventRef(sessionId, owner, item.entry.originalIndex);
        const label = `${activityName(item)} · ${activityTime(item)}`;
        return (
          <Stack gap={0}>
            {ref === null ? (
              <Text size="xs" title={label}>
                {truncateTitle(label)}
              </Text>
            ) : (
              <DetailLink label={`Inspect ${label}`} entityRef={ref} onOpen={() => interaction?.openEntity(ref)}>
                {label}
              </DetailLink>
            )}
            {ref === null && interaction !== null && sessionId !== null && (
              <DetailLink
                label={`Open owner ${owner.topic}`}
                entityRef={{ kind: "node", sessionId, nodeId: owner.node_id }}
                onOpen={() => interaction.openEntity({ kind: "node", sessionId, nodeId: owner.node_id })}
              >
                {owner.topic}
              </DetailLink>
            )}
          </Stack>
        );
      },
    },
    {
      id: "model",
      accessorFn: (row) => row.model ?? undefined,
      header: "Model",
      sortUndefined: "last",
      cell: (context) => context.row.original.model ?? MISSING,
    },
    {
      id: "cacheTtl",
      accessorFn: (row) => row.cacheTtl,
      header: "Cache TTL",
      cell: (context) => context.row.original.cacheTtl,
    },
    {
      id: "resumeCount",
      accessorFn: (row) => row.resumeCount,
      header: "Resumes",
      cell: (context) => context.row.original.resumeCount,
    },
    {
      id: "duration",
      accessorFn: (row) => row.duration.value ?? undefined,
      header: "Duration",
      sortUndefined: "last",
      cell: (context) => {
        const row = context.row.original;
        return metricCell(
          row.duration.value,
          durationScale,
          withProvenance(formatDuration(row.duration.value), row.duration),
        );
      },
    },
    {
      id: "cost",
      accessorFn: (row) => row.cost.usd ?? undefined,
      header: "Costs",
      sortUndefined: "last",
      cell: (context) => {
        const row = context.row.original;
        return metricCell(row.cost.usd, costScale, formatCostWithPercent(row));
      },
    },
    {
      id: "tokensTotal",
      accessorFn: (row) => row.tokensTotal.value ?? undefined,
      header: "Tokens (total)",
      sortUndefined: "last",
      cell: (context) => {
        const row = context.row.original;
        return metricCell(
          row.tokensTotal.value,
          tokensTotalScale,
          withProvenance(formatTokens(row.tokensTotal.value), row.tokensTotal),
        );
      },
    },
    {
      id: "tokensInput",
      accessorFn: (row) => row.tokensInput.value ?? undefined,
      header: "Tokens (in)",
      sortUndefined: "last",
      cell: (context) => {
        const row = context.row.original;
        return metricCell(
          row.tokensInput.value,
          tokensInputScale,
          withProvenance(formatTokens(row.tokensInput.value), row.tokensInput),
        );
      },
    },
    {
      id: "tokensOutput",
      accessorFn: (row) => row.tokensOutput.value ?? undefined,
      header: "Tokens (out)",
      sortUndefined: "last",
      cell: (context) => {
        const row = context.row.original;
        return metricCell(
          row.tokensOutput.value,
          tokensOutputScale,
          withProvenance(formatTokens(row.tokensOutput.value), row.tokensOutput),
        );
      },
    },
  ];
}

/** One row per agent identified anywhere in the tree, with its total duration, own cost and own tokens. */
export function AgentSummaryTable({
  root,
  onSelectAgent,
  workflowIndex: suppliedWorkflowIndex,
  activityFilter = "all",
  scopeId = null,
  scopeOnly = false,
  onScopeOnly,
  onActivityReset,
  hierarchyMatchCount,
}: {
  root: NodeOut;
  onSelectAgent: (agentId: number) => void;
  workflowIndex?: WorkflowIndex;
  activityFilter?: ActivityFilter;
  scopeId?: string | null;
  scopeOnly?: boolean;
  onScopeOnly?: (value: boolean) => void;
  onActivityReset?: () => void;
  hierarchyMatchCount?: number;
}) {
  const isPhone = useMediaQuery("(max-width: 48em)");
  const routerLocation = useLocation();
  const allRows = useMemo(() => agentSummaryRows(root), [root]);
  const workflowIndex = useMemo(() => suppliedWorkflowIndex ?? buildWorkflowIndex(root), [root, suppliedWorkflowIndex]);
  const observations = workflowIndex.agentObservations;
  const scopedAgentIds = useMemo(() => agentsInScope(workflowIndex, scopeId), [scopeId, workflowIndex]);
  const rows = useMemo(
    () =>
      allRows.filter(
        (row) =>
          (!scopeOnly || scopedAgentIds === null || scopedAgentIds.has(row.agentId)) &&
          (activityFilter === "all" || observations.get(row.agentId)?.status === activityFilter),
      ),
    [activityFilter, allRows, observations, scopeOnly, scopedAgentIds],
  );
  const interaction = useSessionInteraction();
  const selectionRef = interaction?.location.selection ?? null;
  const resolvedSelection = interaction?.resolved ?? null;
  const nodesByAgent = useMemo(() => {
    const nodes = new Map<number, NodeOut>();
    for (const row of rows) {
      const node = agentNode(root, row.agentId);
      if (node !== null) nodes.set(row.agentId, node);
    }
    return nodes;
  }, [rows, root]);
  const selectionRelations = useMemo(
    () => relationsToNodes(root, selectionRef, resolvedSelection),
    [root, selectionRef, resolvedSelection],
  );
  const menuTarget = useInspectionMenuTarget((target) => {
    if (interaction === null) return [];
    const node = nodesByAgent.get(Number(target.dataset.agentId));
    if (node === undefined) return [];
    const ref = { kind: "node" as const, sessionId: interaction.sessionId, nodeId: node.node_id };
    const actions: InspectionAction[] = [
      { id: "details", label: "Show details", run: () => interaction.openEntity(ref) },
    ];
    const parentId = navigationParentId(interaction.root, node.node_id);
    if (parentId !== null)
      actions.push({ id: "parent", label: "Show parent agent", run: () => interaction.openNode(parentId) });
    actions.push({ id: "copy", label: "Copy link", run: () => interaction.copyLink(ref) });
    return actions;
  });
  const [sorting, setSortingState] = useState<SortingState>(() => {
    const saved = interaction?.memory.get("agent-summary:sorting");
    return Array.isArray(saved) ? (saved as SortingState) : [{ id: "agentId", desc: false }];
  });
  const [expandedMetrics, setExpandedMetricsState] = useState<number[]>(() => {
    const saved = interaction?.memory.get("agent-summary:expanded-metrics");
    return Array.isArray(saved) ? (saved as number[]) : [];
  });
  const interactionRef = useRef(interaction);
  interactionRef.current = interaction;
  const saveCurrentSnapshot = () => {
    if (interaction?.restoringHistory) return;
    const historyState = typeof window === "undefined" ? null : (window.history.state as { key?: string } | null);
    const browserKey = historyState?.key ?? "default";
    if (browserKey === routerLocation.key) interactionRef.current?.saveSnapshot();
  };
  const sortingRef = useRef(sorting);
  sortingRef.current = sorting;
  const updateSorting = (next: SortingState | ((previous: SortingState) => SortingState)) => {
    const value = typeof next === "function" ? next(sortingRef.current) : next;
    sortingRef.current = value;
    interaction?.memory.set("agent-summary:sorting", value);
    setSortingState(value);
    saveCurrentSnapshot();
  };
  const expandedMetricsRef = useRef(expandedMetrics);
  expandedMetricsRef.current = expandedMetrics;
  const updateExpandedMetrics = (next: number[] | ((previous: number[]) => number[])) => {
    const value = typeof next === "function" ? next(expandedMetricsRef.current) : next;
    expandedMetricsRef.current = value;
    interaction?.memory.set("agent-summary:expanded-metrics", value);
    setExpandedMetricsState(value);
    saveCurrentSnapshot();
  };
  const restoredVersion = useRef(interaction?.restorationVersion ?? 0);
  useLayoutEffect(() => {
    if (interaction?.restoringHistory || interaction?.restorationVersion === restoredVersion.current) return;
    restoredVersion.current = interaction?.restorationVersion ?? 0;
    const savedSorting = interaction?.memory.get("agent-summary:sorting");
    const savedMetrics = interaction?.memory.get("agent-summary:expanded-metrics");
    if (Array.isArray(savedSorting)) {
      sortingRef.current = savedSorting as SortingState;
      setSortingState(savedSorting as SortingState);
    }
    if (Array.isArray(savedMetrics)) {
      expandedMetricsRef.current = savedMetrics as number[];
      setExpandedMetricsState(savedMetrics as number[]);
    }
  }, [interaction?.memory, interaction?.restorationVersion, interaction?.restoringHistory]);
  const tableColumns = useMemo(
    () =>
      columns(
        rows,
        nodesByAgent,
        observations,
        workflowIndex,
        interaction,
        onSelectAgent,
        interaction?.sessionId ?? null,
      ),
    [rows, nodesByAgent, observations, workflowIndex, interaction, onSelectAgent],
  );
  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    state: { sorting },
    onSortingChange: updateSorting,
    getRowId: (row) => String(row.agentId),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rowsInView = table.getRowModel().rows;
  const metrics = [
    ["model", "Model"],
    ["duration", "Duration"],
    ["cost", "Own cost"],
    ["tokensInput", "Input tokens"],
    ["tokensOutput", "Output tokens"],
    ["tokensTotal", "Total tokens"],
    ["cacheTtl", "Cache TTL"],
    ["resumeCount", "Resumes"],
  ] as const;

  return (
    <Stack gap={4} className={classes.root}>
      <Title order={5}>Agent summary</Title>
      <Text size="xs">Complete-agent totals; session cost share</Text>
      <Text size="xs">
        Hierarchy rows matching: {hierarchyMatchCount ?? "—"} · Logical agents matching: {rows.length}
      </Text>
      {onScopeOnly !== undefined && (
        <Switch
          label="Agents in focused subtree"
          checked={scopeOnly}
          disabled={scopeId === null || scopeId === root.node_id}
          onChange={(event) => onScopeOnly(event.currentTarget.checked)}
        />
      )}
      {rows.length === 0 && (
        <Stack gap={4}>
          <Text role="status">
            {activityFilter === "all"
              ? "No agents are present in this focused subtree"
              : "No agents match this activity filter"}
          </Text>
          {activityFilter !== "all" && onActivityReset !== undefined && (
            <button type="button" onClick={onActivityReset}>
              Clear activity filter
            </button>
          )}
        </Stack>
      )}
      {rows.length > 0 && (
        <>
          {isPhone && (
            <Stack gap="xs" className={classes.phoneControls}>
              <NativeSelect
                label="Sort agents"
                value={sorting[0]?.id ?? "agentId"}
                data={[
                  { value: "agentId", label: "Agent" },
                  { value: "activity", label: "Activity" },
                  { value: "topic", label: "Topic" },
                  { value: "latestActivity", label: "Latest observed activity" },
                  { value: "model", label: "Model" },
                  { value: "cacheTtl", label: "Cache TTL" },
                  { value: "resumeCount", label: "Resumes" },
                  { value: "duration", label: "Duration" },
                  { value: "cost", label: "Own cost" },
                  { value: "tokensTotal", label: "Total tokens" },
                  { value: "tokensInput", label: "Input tokens" },
                  { value: "tokensOutput", label: "Output tokens" },
                ]}
                onChange={(event) => {
                  table.setSorting([{ id: event.currentTarget.value, desc: sortingRef.current[0]?.desc ?? false }]);
                }}
              />
              <NativeSelect
                label="Sort direction"
                value={sorting[0]?.desc ? "desc" : "asc"}
                data={[
                  { value: "desc", label: "Descending" },
                  { value: "asc", label: "Ascending" },
                ]}
                onChange={(event) => {
                  table.setSorting([
                    { id: sortingRef.current[0]?.id ?? "agentId", desc: event.currentTarget.value === "desc" },
                  ]);
                }}
              />
            </Stack>
          )}
          {!isPhone && (
            <Table highlightOnHover verticalSpacing={2} data-testid="agent-summary-table">
              <Table.Thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <Table.Tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <Table.Th
                        key={header.id}
                        onClick={header.column.getToggleSortingHandler()}
                        style={{ cursor: "pointer", whiteSpace: "nowrap" }}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sortMark(header.column.getIsSorted())}
                      </Table.Th>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Thead>
              <Table.Tbody>
                {table.getRowModel().rows.map((row) => (
                  <Table.Tr
                    key={row.id}
                    data-testid={`agent-summary-row-${row.id}`}
                    data-agent-id={row.original.agentId}
                    className={selectionClasses.item}
                    data-selection={(() => {
                      if (interaction === null) return "none";
                      const relation =
                        selectionRelations.get(nodesByAgent.get(row.original.agentId)?.node_id ?? "") ?? "none";
                      return relation;
                    })()}
                    tabIndex={0}
                    aria-selected={
                      selectionRelations.get(nodesByAgent.get(row.original.agentId)?.node_id ?? "") === "exact"
                    }
                    onClick={() => {
                      const node = nodesByAgent.get(row.original.agentId);
                      if (interaction !== null && node !== undefined) {
                        interaction.selectEntity({
                          kind: "node",
                          sessionId: interaction.sessionId,
                          nodeId: node.node_id,
                        });
                      }
                    }}
                    {...menuTarget}
                    onKeyDown={(event) => {
                      menuTarget.onKeyDown(event);
                      if (event.defaultPrevented) return;
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        const node = nodesByAgent.get(row.original.agentId);
                        if (interaction !== null && node !== undefined) {
                          interaction.selectEntity({
                            kind: "node",
                            sessionId: interaction.sessionId,
                            nodeId: node.node_id,
                          });
                        }
                      }
                    }}
                    style={{ cursor: "default" }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <Table.Td
                        key={cell.id}
                        className={cell.column.id === "activity" ? classes.activityColumn : undefined}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
          {isPhone && (
            <Table className={classes.cards} data-testid="agent-summary-cards" aria-label="Agent summaries">
              <Table.Tbody>
                {rowsInView.map((row) => {
                  const agentId = row.original.agentId;
                  const node = nodesByAgent.get(agentId);
                  const selectedRelation = selectionRelations.get(node?.node_id ?? "") ?? "none";
                  const open = expandedMetrics.includes(agentId);
                  const content = (id: string) => {
                    const cell = row.getAllCells().find((candidate) => candidate.column.id === id);
                    return cell === undefined ? MISSING : flexRender(cell.column.columnDef.cell, cell.getContext());
                  };
                  return (
                    <Table.Tr
                      key={row.id}
                      data-testid={`agent-summary-card-${agentId}`}
                      data-agent-id={agentId}
                      data-selection={selectedRelation}
                      aria-selected={selectedRelation === "exact"}
                      className={`${classes.card} ${selectionClasses.item}`}
                      tabIndex={0}
                      onClick={(event) => {
                        if (event.button !== 0) return;
                        if (interaction !== null && node !== undefined)
                          interaction.selectEntity({
                            kind: "node",
                            sessionId: interaction.sessionId,
                            nodeId: node.node_id,
                          });
                      }}
                      {...menuTarget}
                      onKeyDown={(event) => {
                        menuTarget.onKeyDown(event);
                        if (event.defaultPrevented || event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          if (interaction !== null && node !== undefined)
                            interaction.selectEntity({
                              kind: "node",
                              sessionId: interaction.sessionId,
                              nodeId: node.node_id,
                            });
                        }
                      }}
                    >
                      <Table.Td className={classes.cardIdentity}>
                        <AgentBadge agentId={agentId} active={row.original.active} />
                        <div className={classes.cardTopic}>
                          <Text size="xs" c="dimmed">
                            Representative topic
                          </Text>
                          {content("topic")}
                        </div>
                      </Table.Td>
                      <Table.Td className={classes.cardState}>
                        {observations.get(agentId)?.status !== undefined &&
                          observations.get(agentId)?.status !== "unknown" && (
                            <div>
                              <Text size="xs" c="dimmed">
                                Workflow status
                              </Text>
                              {content("activity")}
                            </div>
                          )}
                        <div>
                          <Text size="xs" c="dimmed">
                            Latest observed activity
                          </Text>
                          {content("latestActivity")}
                        </div>
                        <div>
                          <Text size="xs" c="dimmed">
                            Own cost / session share
                          </Text>
                          {content("cost")}
                        </div>
                      </Table.Td>
                      <Table.Td className={classes.metricsDisclosureCell}>
                        <div className={classes.metricsDisclosureRow}>
                          <span
                            className={classes.metricsCaption}
                            data-testid={`agent-summary-metrics-caption-${agentId}`}
                          >
                            Agent {agentId} metrics
                          </span>
                          <details
                            className={classes.metricsDisclosure}
                            open={open}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (!(event.target instanceof HTMLElement) || event.target.closest("summary") === null)
                                return;
                              event.preventDefault();
                              updateExpandedMetrics((previous) =>
                                previous.includes(agentId)
                                  ? previous.filter((id) => id !== agentId)
                                  : [...previous, agentId],
                              );
                            }}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <summary aria-label={`Agent ${agentId} metrics`}>
                              <span aria-hidden="true" className={classes.disclosureTriangle}>
                                ▶
                              </span>
                              <span className={classes.screenReaderOnly}>Agent {agentId} metrics</span>
                            </summary>
                            <dl className={classes.metricList} data-testid={`agent-summary-metrics-${agentId}`}>
                              {metrics.map(([id, label]) => (
                                <div key={id}>
                                  <dt>{label}</dt>
                                  <dd>{content(id)}</dd>
                                </div>
                              ))}
                              <div>
                                <dt>Cost share denominator</dt>
                                <dd>Known all-agent own cost total</dd>
                              </div>
                            </dl>
                          </details>
                        </div>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          )}
        </>
      )}
    </Stack>
  );
}
