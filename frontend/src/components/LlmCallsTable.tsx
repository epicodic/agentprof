// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Stack, Table, Text } from "@mantine/core";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { NodeOut } from "../api/types";
import { type CallRef, callRefs, eventRefs, resolveEntity, sameEntity } from "../lib/entities";
import { type InspectionEntry, type InspectionRow, inspectionRows } from "../lib/inspectionSequence";
import { sinceAgentStart } from "../lib/llmCallRows";
import { metricScale } from "../lib/metricColor";
import { toolExecutions } from "../lib/toolExecutions";
import { ActivityInspectionRow } from "./ActivityInspectionRow";
import tableClasses from "./DetailTable.module.css";
import { LlmCallRow } from "./LlmCallRow";
import { SequenceControls, useSequenceSettings } from "./SequenceControls";
import { type FocusRequest, focusRequestToken, useInspectionMemory, useSessionInteraction } from "./SessionInteraction";
import { ToolExecutionRow } from "./ToolExecutionRow";
import { ToolGroupRow } from "./ToolGroupRow";

interface Props {
  node: NodeOut;
  agentStart: number | null;
  focusRequest?: FocusRequest | null;
  title?: string;
  onSelect: (nodeId: string) => void;
  tableRole?: string;
}

export function callExpansionKey(callRef: ReturnType<typeof callRefs>[number] | null, index: number): string {
  return `call-${callRef?.callKey ?? `index:${index}`}`;
}

const EMPTY_EVENTS: NonNullable<NodeOut["execution_events"]> = [];
const eventGenerations = new WeakMap<object, number>();
let nextEventGeneration = 0;
function eventGeneration(events: NodeOut["execution_events"]): number {
  const list = events ?? EMPTY_EVENTS;
  let generation = eventGenerations.get(list);
  if (generation === undefined) {
    generation = ++nextEventGeneration;
    eventGenerations.set(list, generation);
  }
  return generation;
}
export function localEventExpansionKey(events: NodeOut["execution_events"], serial: string | number): string {
  return `local-${eventGeneration(events)}-${serial}`;
}
export function eventRowKey(
  ref: ReturnType<typeof eventRefs>[number] | null,
  events: NodeOut["execution_events"],
  serial: string | number,
): string {
  return ref === null ? `event-${localEventExpansionKey(events, serial)}` : `event-${ref.eventId}`;
}

export function LlmCallsTable({
  node,
  agentStart,
  focusRequest = null,
  title = "LLM calls",
  onSelect: _onSelect,
  tableRole = "standalone",
}: Props) {
  const interaction = useSessionInteraction();
  const sessionId = interaction?.sessionId ?? null;
  const root = interaction?.root ?? node;
  const refs = useMemo(() => (sessionId === null ? [] : callRefs(sessionId, node)), [sessionId, node]);
  const eventIdentityRefs = useMemo(() => (sessionId === null ? [] : eventRefs(sessionId, node)), [sessionId, node]);
  const projection = useMemo(() => toolExecutions(node, root), [node, root]);
  const [settings, setSettings] = useSequenceSettings(node.node_id, tableRole);
  const rows = useMemo(
    () => inspectionRows(node, root, settings.query, settings.order, settings.descending),
    [node, root, settings],
  );
  const [expandedCalls, setExpandedCalls] = useInspectionMemory<string[]>(`expand:${node.node_id}:${tableRole}`, () =>
    focusRequest?.kind === "call" && focusRequest.ownerId === node.node_id && focusRequest.expand !== false
      ? [callExpansionKey(refs[focusRequest.index] ?? null, focusRequest.index)]
      : [],
  );
  const [expandedTools, setExpandedTools] = useInspectionMemory<string[]>(
    `expand-tools:${node.node_id}:${tableRole}`,
    () => {
      if (focusRequest?.kind !== "event" || focusRequest.ownerId !== node.node_id) return [];
      const index = (node.execution_events ?? []).findIndex((event) => event.event_id === focusRequest.eventId);
      const execution = projection.byEventIndex.get(index);
      return execution ? [execution.key] : [];
    },
  );
  const [expandedToolGroups, setExpandedToolGroups] = useInspectionMemory<string[]>(
    `expand-tool-groups:${node.node_id}:${tableRole}`,
    () => [],
  );
  const [expandedEvents, setExpandedEvents] = useInspectionMemory<string[]>(
    `expand-activity:${node.node_id}:${tableRole}`,
    () => [],
  );
  const tableContainer = useRef<HTMLDivElement>(null);
  const [jumpTarget, setJumpTarget] = useState<CallRef | null>(() =>
    focusRequest?.kind === "call" && focusRequest.expand === false && focusRequest.ownerId === node.node_id
      ? (refs[focusRequest.index] ?? null)
      : null,
  );
  const jumpToCall = (ref: CallRef) => {
    if (interaction === null) return;
    if (ref.ownerId !== node.node_id) {
      interaction.openEntity(ref, false);
      return;
    }
    interaction.selectEntity(ref);
    setSettings((old) => ({ ...old, query: "" }));
    setJumpTarget(ref);
  };
  useEffect(() => {
    if (jumpTarget === null || sessionId === null || tableContainer.current === null) return;
    const resolved = resolveEntity(root, sessionId, jumpTarget);
    if (resolved?.index === null || resolved?.index === undefined) {
      setJumpTarget(null);
      return;
    }
    if (!rows.some((row) => row.kind === "call" && row.originalIndex === resolved.index)) return;
    const id = `call-cost-${jumpTarget.ownerId}-${resolved.index}`;
    const row = Array.from(tableContainer.current.querySelectorAll<HTMLTableRowElement>("tr[data-testid]")).find(
      (element) => element.dataset.testid === id,
    );
    if (row) {
      row.scrollIntoView({ block: "center", inline: "nearest" });
      setJumpTarget(null);
    }
  }, [jumpTarget, rows, root, sessionId]);
  const focusTrigger = focusRequest === null ? null : focusRequestToken(focusRequest);
  const [lastHandledFocus, setLastHandledFocus] = useInspectionMemory<string | null>(
    `focus-handled:${node.node_id}:${tableRole}`,
    () => focusTrigger,
  );
  const selected = interaction?.location.selection ?? null;
  const activePanel =
    interaction === null ||
    (tableRole.includes("workflow")
      ? interaction.location.tab === "workflow"
      : tableRole === "standalone" || interaction.location.tab === "workflow" || interaction.location.tab === "calls");
  useEffect(() => {
    if (
      focusRequest === null ||
      focusTrigger === null ||
      !activePanel ||
      interaction?.restoringHistory ||
      lastHandledFocus === focusTrigger
    )
      return;
    if (focusRequest.kind === "call" && focusRequest.ownerId === node.node_id) {
      const key = callExpansionKey(refs[focusRequest.index] ?? null, focusRequest.index);
      if (focusRequest.expand === false) {
        setSettings((old) => ({ ...old, query: "" }));
        setJumpTarget(refs[focusRequest.index] ?? null);
      } else setExpandedCalls((old) => (old.includes(key) ? old : [...old, key]));
    }
    if (focusRequest.kind === "event" && focusRequest.ownerId === node.node_id) {
      const index = (node.execution_events ?? []).findIndex((event) => event.event_id === focusRequest.eventId);
      const execution = projection.byEventIndex.get(index);
      if (execution) setExpandedTools((old) => (old.includes(execution.key) ? old : [...old, execution.key]));
      else if (index >= 0)
        setExpandedEvents((old) => (old.includes(focusRequest.eventId) ? old : [...old, focusRequest.eventId]));
    }
    setLastHandledFocus(focusTrigger);
  }, [
    focusRequest,
    focusTrigger,
    lastHandledFocus,
    setLastHandledFocus,
    activePanel,
    interaction?.restoringHistory,
    node,
    refs,
    projection,
    setExpandedCalls,
    setExpandedTools,
    setExpandedEvents,
    setSettings,
  ]);

  if (
    node.llm_calls.length === 0 &&
    (node.execution_events ?? []).length === 0 &&
    !node.children.some((child) => child.kind === "tool")
  )
    return null;
  const durationScale = metricScale(node.llm_calls.map((call) => call.duration.value));
  const costScale = metricScale(node.llm_calls.map((call) => call.cost.usd));
  const selectedEventIndex =
    selected?.kind === "event" && selected.ownerId === node.node_id
      ? (node.execution_events ?? []).findIndex((event) => event.event_id === selected.eventId)
      : -1;
  const selectedExecutionKey =
    selectedEventIndex < 0 ? null : (projection.byEventIndex.get(selectedEventIndex)?.key ?? null);
  const selectedEventVisible = rows.some((row) =>
    row.kind === "activity"
      ? row.originalIndex === selectedEventIndex
      : row.kind === "tool"
        ? row.execution.sourceEventIndexes.includes(selectedEventIndex)
        : row.kind === "tools" &&
          row.executions.some((execution) => execution.sourceEventIndexes.includes(selectedEventIndex)),
  );
  const columns = 5;
  const setOrder = (order: "chronological" | "cost" | "duration" | "tokens") => {
    setSettings((old) => ({
      order,
      descending: order === "chronological" ? false : old.order === order ? !old.descending : true,
      query: old.query,
    }));
  };
  const ariaSort = (order: "chronological" | "cost" | "duration" | "tokens") =>
    settings.order !== order
      ? "none"
      : settings.order === "chronological"
        ? "ascending"
        : settings.descending
          ? "descending"
          : "ascending";
  const renderCall = (entry: Extract<InspectionEntry, { kind: "call" }>) => {
    const callRef = refs[entry.originalIndex] ?? null;
    const key = callExpansionKey(callRef, entry.originalIndex);
    return (
      <LlmCallRow
        key={`call-${entry.originalIndex}`}
        ownerId={node.node_id}
        index={entry.originalIndex}
        call={entry.call}
        callRef={callRef}
        expanded={expandedCalls.includes(key)}
        focused={focusRequest?.kind === "call" && focusRequest.index === entry.originalIndex}
        selected={callRef !== null && sameEntity(selected, callRef)}
        offset={sinceAgentStart(entry.call.start.value, agentStart)}
        durationScale={durationScale}
        costScale={costScale}
        onToggle={() =>
          setExpandedCalls((old) => (old.includes(key) ? old.filter((value) => value !== key) : [...old, key]))
        }
        onSelect={() => callRef !== null && interaction?.selectEntity(callRef)}
        onMarkLocal={() => interaction?.markLocal(`call:${node.node_id}`, key)}
        localSelected={interaction?.localMark?.viewKey === `call:${node.node_id}` && interaction.localMark.key === key}
      />
    );
  };
  const renderActivity = (entry: Extract<InspectionEntry, { kind: "activity" }>) => {
    const ref = eventIdentityRefs[entry.originalIndex] ?? null;
    const key = ref?.eventId ?? localEventExpansionKey(node.execution_events, entry.originalIndex);
    return (
      <ActivityInspectionRow
        key={eventRowKey(ref, node.execution_events, entry.originalIndex)}
        event={entry.event}
        eventRef={ref}
        selected={ref !== null && sameEntity(selected, ref)}
        localSelected={
          interaction?.localMark?.viewKey === `activity:${node.node_id}` && interaction.localMark.key === key
        }
        expanded={expandedEvents.includes(key)}
        onMark={() => (ref ? interaction?.selectEntity(ref) : interaction?.markLocal(`activity:${node.node_id}`, key))}
        onToggle={() =>
          setExpandedEvents((old) => (old.includes(key) ? old.filter((value) => value !== key) : [...old, key]))
        }
      />
    );
  };
  const renderRow = (row: InspectionRow, rowIndex: number) => {
    if (row.kind === "call") return renderCall(row);
    if (row.kind === "activity") return renderActivity(row);
    const executions = row.kind === "tools" ? row.executions : [row.execution];
    const renderExecutions = () =>
      executions.map((execution) => (
        <ToolExecutionRow
          key={execution.key}
          execution={execution}
          onJumpToCall={jumpToCall}
          offset={sinceAgentStart(execution.startMs, agentStart)}
          expanded={expandedTools.includes(execution.key)}
          legacySelected={selectedExecutionKey === execution.key}
          onToggle={() =>
            setExpandedTools((old) =>
              old.includes(execution.key) ? old.filter((value) => value !== execution.key) : [...old, execution.key],
            )
          }
        />
      ));
    if (row.kind !== "tools" || (executions.length === 1 && row.sourceCount === 1)) return renderExecutions();
    const expanded = expandedToolGroups.includes(row.key) || settings.query.trim() !== "";
    return (
      <Fragment key={`tool-group-content-${row.key}`}>
        <ToolGroupRow
          ownerId={node.node_id}
          index={rowIndex}
          executions={executions}
          sourceCount={row.sourceCount}
          expanded={expanded}
          onToggle={() => {
            if (!expanded) {
              setExpandedTools((old) => [...new Set([...old, ...executions.map((execution) => execution.key)])]);
            }
            setExpandedToolGroups((old) =>
              old.includes(row.key) ? old.filter((key) => key !== row.key) : [...old, row.key],
            );
          }}
        />
        {expanded && renderExecutions()}
      </Fragment>
    );
  };
  return (
    <Stack gap={4} style={{ minWidth: 0, maxWidth: "100%" }}>
      {title !== "" && (
        <Text fw={600} size="sm">
          {title}
        </Text>
      )}
      <SequenceControls ownerId={node.node_id} settings={settings} onChange={setSettings} />
      {settings.order !== "chronological" && (
        <Text size="xs" c="dimmed" role="note">
          Tools follow recorded requester links when available; otherwise they stay with the preceding timed call by
          position. Position alone does not establish causality.
        </Text>
      )}
      {selectedEventIndex >= 0 && !selectedEventVisible && (
        <Text size="xs" c="dimmed" role="status">
          Marked event is hidden by this search.
        </Text>
      )}
      {eventIdentityRefs.some((ref) => ref === null) && (
        <Text size="xs" c="dimmed">
          Some event identities are unavailable; inline evidence remains available.
        </Text>
      )}
      <div
        ref={tableContainer}
        data-testid={`calls-scroll-${node.node_id}`}
        style={{ overflowX: "auto", maxWidth: "100%", minWidth: 0 }}
      >
        <Table
          highlightOnHover
          verticalSpacing={2}
          className={`${tableClasses.table} ${tableClasses.calls}`}
          style={{ tableLayout: "fixed", minWidth: 640 }}
        >
          <colgroup>
            <col className={tableClasses.timeColumn} />
            <col />
            <col className={tableClasses.durationColumn} />
            <col className={tableClasses.costColumn} />
            <col className={tableClasses.tokensColumn} />
          </colgroup>
          <Table.Thead>
            <Table.Tr>
              <Table.Th aria-sort={ariaSort("chronological")}>
                <button type="button" onClick={() => setOrder("chronological")}>
                  Time
                </button>
              </Table.Th>
              <Table.Th>Item</Table.Th>
              {(["duration", "cost", "tokens"] as const).map((order) => (
                <Table.Th key={order} ta="right" aria-sort={ariaSort(order)}>
                  <button type="button" onClick={() => setOrder(order)}>
                    {order[0].toUpperCase() + order.slice(1)}
                    {settings.order === order ? (settings.descending ? " ↓" : " ↑") : ""}
                  </button>
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={columns}>
                  <Text size="xs" c="dimmed">
                    No sequence entries match this search.
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {rows.map((row, rowIndex) => (
              <Fragment
                key={
                  row.kind === "tools"
                    ? row.key
                    : row.kind === "call"
                      ? `call-${row.originalIndex}`
                      : row.kind === "activity"
                        ? `activity-${row.originalIndex}`
                        : `tool-${row.execution.key}`
                }
              >
                {renderRow(row, rowIndex)}
              </Fragment>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </Stack>
  );
}
