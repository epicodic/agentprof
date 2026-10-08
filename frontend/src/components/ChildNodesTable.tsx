// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { ActionIcon, Badge, Group, Stack, Table, Text, Title } from "@mantine/core";
import { Fragment, useEffect, useMemo } from "react";
import { type EntityRef, relationsToNodes } from "../lib/entities";
import {
  formatCost,
  formatDuration,
  formatTokens,
  MISSING,
  totalTokens,
  truncateTitle,
  withProvenance,
} from "../lib/format";
import { colorForMetric, metricScale } from "../lib/metricColor";
import { findNode, navigationParentId, rowFindingCount, subAgents, type TimedChild, turns } from "../lib/tree";
import { DetailLink } from "./DetailLink";
import tableClasses from "./DetailTable.module.css";
import selectionClasses from "./EntitySelection.module.css";
import { type InspectionAction, useInspectionMenuTarget } from "./InspectionMenu";
import { LlmCallsTable } from "./LlmCallsTable";
import { type FocusRequest, focusRequestToken, useInspectionMemory, useSessionInteraction } from "./SessionInteraction";

interface Props {
  title: string;
  /** Rows get `data-testid="<testIdPrefix>-<node id>"`. */
  testIdPrefix: string;
  callIdPrefix?: string;
  items: TimedChild[];
  mainAgentStart: number | null;
  onSelect: (nodeId: string) => void;
  focusedEntity?: FocusRequest | null;
  inspectionNodeId?: string;
  tableRole?: "workflow" | "calls";
  hierarchical?: boolean;
}

/** A table of a node's direct children (sub-agents or turns); a click selects one. */
export function ChildNodesTable({
  title,
  testIdPrefix,
  callIdPrefix = "expand-calls",
  items,
  mainAgentStart,
  onSelect,
  focusedEntity = null,
  inspectionNodeId,
  tableRole = "workflow",
  hierarchical = false,
}: Props) {
  const interaction = useSessionInteraction();
  const selectionRoot = interaction?.root ?? null;
  const selectionRef = interaction?.location.selection ?? null;
  const resolvedSelection = interaction?.resolved ?? null;
  const [expandedKeys, setExpandedKeys] = useInspectionMemory<string[]>(
    `expand:${inspectionNodeId ?? interaction?.location.nodeId ?? "standalone"}:${tableRole}:${testIdPrefix}`,
    () => [],
  );
  const expanded = new Set(expandedKeys);
  const focusOwnerId = focusedEntity?.ownerId ?? null;
  const focusBranch =
    focusOwnerId === null
      ? null
      : (items.find(
          ({ node: child }) =>
            child.node_id === focusOwnerId || (hierarchical && findNode(child, focusOwnerId) !== null),
        )?.node.node_id ?? null);
  const focusTrigger = focusedEntity === null ? null : focusRequestToken(focusedEntity);
  const activePanel =
    interaction === null || interaction.location.tab === "workflow" || interaction.location.tab === "calls";
  const revealScope = `reveal-handled:${inspectionNodeId ?? interaction?.location.nodeId ?? "standalone"}:${tableRole}:${testIdPrefix}`;
  const [lastHandledReveal, setLastHandledReveal] = useInspectionMemory<string | null>(revealScope, () =>
    interaction?.restoringHistory === true ? focusTrigger : null,
  );
  useEffect(() => {
    if (
      focusTrigger === null ||
      focusBranch === null ||
      !activePanel ||
      interaction?.restoringHistory === true ||
      lastHandledReveal === focusTrigger
    )
      return;
    setExpandedKeys((previous) => (previous.includes(focusBranch) ? previous : [...previous, focusBranch]));
    setLastHandledReveal(focusTrigger);
  }, [
    activePanel,
    focusTrigger,
    focusBranch,
    interaction?.restoringHistory,
    lastHandledReveal,
    setExpandedKeys,
    setLastHandledReveal,
  ]);
  const selectionRelations = useMemo(
    () => (selectionRoot === null ? new Map() : relationsToNodes(selectionRoot, selectionRef, resolvedSelection)),
    [selectionRoot, selectionRef, resolvedSelection],
  );
  const menuTarget = useInspectionMenuTarget((target) => {
    if (interaction === null) return [];
    const child = findNode(interaction.root, target.dataset.nodeId ?? "");
    if (child === null) return [];
    const ref: EntityRef = { kind: "node", sessionId: interaction.sessionId, nodeId: child.node_id };
    const actions: InspectionAction[] = [
      { id: "details", label: "Show details", run: () => interaction.openEntity(ref) },
    ];
    const parentId = navigationParentId(interaction.root, child.node_id);
    if (parentId !== null) {
      actions.push({ id: "parent", label: "Show parent agent", run: () => interaction.openNode(parentId) });
    }
    actions.push({ id: "copy", label: "Copy link", run: () => interaction.copyLink(ref) });
    return actions;
  });
  if (items.length === 0) return null;
  const durationScale = metricScale(items.map(({ node }) => node.duration.value));
  const tokensScale = metricScale(items.map(({ node }) => totalTokens(node.tokens_total)));
  const ownCostScale = metricScale(items.map(({ node }) => node.cost_own.usd));
  const totalCostScale = metricScale(items.map(({ node }) => node.cost_total.usd));
  return (
    <Stack gap={4}>
      {title !== "" && <Title order={5}>{title}</Title>}
      <div className={tableClasses.childTableContainer}>
        <Table highlightOnHover verticalSpacing={2} className={`${tableClasses.table} ${tableClasses.children}`}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th ta="right" className={tableClasses.offsetColumn}>
                Start
              </Table.Th>
              <Table.Th ta="right" className={tableClasses.durationColumn}>
                Duration
              </Table.Th>
              <Table.Th>Topic</Table.Th>
              <Table.Th className={tableClasses.modelColumn}>Model</Table.Th>
              <Table.Th ta="right" className={tableClasses.tokensColumn}>
                Tokens
              </Table.Th>
              <Table.Th ta="right" className={tableClasses.costColumn}>
                Own cost
              </Table.Th>
              <Table.Th ta="right" className={tableClasses.costColumn}>
                Total cost
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map(({ node: child, offset }) => {
              const findingCount = rowFindingCount(child);
              const isExpanded = expanded.has(child.node_id);
              const rowFocus = focusedEntity?.ownerId === child.node_id ? focusedEntity : null;
              const selection = selectionRelations.get(child.node_id) ?? "none";
              const ref: EntityRef | null =
                interaction === null ? null : { kind: "node", sessionId: interaction.sessionId, nodeId: child.node_id };
              const mark = () => {
                if (ref !== null) interaction?.selectEntity(ref);
              };
              const showDetails = () => {
                if (ref !== null) interaction?.openEntity(ref);
                else onSelect(child.node_id);
              };
              return (
                <Fragment key={child.node_id}>
                  <Table.Tr
                    data-testid={`${testIdPrefix}-${child.node_id}`}
                    data-node-id={child.node_id}
                    className={selectionClasses.item}
                    data-selection={selection}
                    onClick={mark}
                    {...menuTarget}
                    tabIndex={0}
                    onKeyDown={(event) => {
                      menuTarget.onKeyDown(event);
                      if (event.defaultPrevented) return;
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        mark();
                      }
                    }}
                    style={{ cursor: "default" }}
                  >
                    <Table.Td ta="right" data-label="Start">
                      <Text size="xs">{offset === null ? MISSING : `+${formatDuration(offset)}`}</Text>
                    </Table.Td>
                    <Table.Td ta="right" data-label="Duration">
                      <Text size="xs" c={colorForMetric(child.duration.value, durationScale) ?? undefined}>
                        {withProvenance(formatDuration(child.duration.value), child.duration)}
                      </Text>
                    </Table.Td>
                    <Table.Td data-label="Topic">
                      <Group gap={4} wrap="nowrap">
                        {(child.llm_calls.length > 0 ||
                          child.children.some(
                            (item) =>
                              item.kind === "tool" || (hierarchical && (item.kind === "agent" || item.kind === "turn")),
                          )) && (
                          <ActionIcon
                            data-testid={`${callIdPrefix}-${child.node_id}`}
                            aria-label={`${isExpanded ? "Collapse" : "Expand"} LLM calls for ${truncateTitle(child.topic)}`}
                            aria-expanded={isExpanded}
                            size="xs"
                            variant="subtle"
                            onClick={(event) => {
                              event.stopPropagation();
                              setExpandedKeys((previous) => {
                                const next = new Set(previous);
                                if (isExpanded) next.delete(child.node_id);
                                else next.add(child.node_id);
                                return [...next];
                              });
                            }}
                          >
                            {isExpanded ? "▾" : "▸"}
                          </ActionIcon>
                        )}
                        <Text size="xs" lineClamp={1} title={child.topic} className={tableClasses.topic}>
                          <DetailLink label={child.topic} entityRef={ref} onOpen={showDetails}>
                            {child.topic}
                          </DetailLink>
                        </Text>
                        {child.success === false && (
                          <Badge size="xs" color="red">
                            failed
                          </Badge>
                        )}
                        {findingCount > 0 && (
                          <Badge size="xs" color="orange">
                            {findingCount}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td data-label="Model">
                      <Text size="xs">{child.model ?? MISSING}</Text>
                    </Table.Td>
                    <Table.Td ta="right" data-label="Tokens">
                      <Text size="xs" c={colorForMetric(totalTokens(child.tokens_total), tokensScale) ?? undefined}>
                        {formatTokens(totalTokens(child.tokens_total))}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right" data-label="Own cost">
                      <Text
                        size="xs"
                        data-testid="cost-own"
                        c={colorForMetric(child.cost_own.usd, ownCostScale) ?? undefined}
                      >
                        {withProvenance(formatCost(child.cost_own), child.cost_own)}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right" data-label="Total cost">
                      <Text
                        size="xs"
                        data-testid="cost-total"
                        c={colorForMetric(child.cost_total.usd, totalCostScale) ?? undefined}
                      >
                        {withProvenance(formatCost(child.cost_total), child.cost_total)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                  {isExpanded && (
                    <Table.Tr>
                      <Table.Td colSpan={7} data-detail>
                        <LlmCallsTable
                          node={child}
                          agentStart={child.kind === "agent" ? child.start.value : mainAgentStart}
                          onSelect={onSelect}
                          tableRole={`${inspectionNodeId ?? interaction?.location.nodeId ?? "standalone"}:${tableRole}:${testIdPrefix}`}
                          title=""
                          focusRequest={rowFocus}
                        />
                        {hierarchical && (
                          <ChildNodesTable
                            title=""
                            testIdPrefix="sub-agent"
                            items={[...turns(child), ...subAgents(child)]}
                            mainAgentStart={mainAgentStart}
                            onSelect={onSelect}
                            focusedEntity={focusedEntity}
                            inspectionNodeId={child.node_id}
                            tableRole={tableRole}
                            hierarchical
                          />
                        )}
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Fragment>
              );
            })}
          </Table.Tbody>
        </Table>
      </div>
    </Stack>
  );
}
