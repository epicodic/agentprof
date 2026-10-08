// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { ActionIcon, Badge, Group, Table, Text } from "@mantine/core";
import type { NodeOut } from "../api/types";
import { type CallRef, resolveEntity, sameEntity } from "../lib/entities";
import { formatDuration, formatTimestamp, MISSING } from "../lib/format";
import { recordedCallTargets } from "../lib/inspectionActions";
import type { ToolExecution } from "../lib/toolExecutions";
import { toolExecutionName } from "../lib/toolExecutions";
import { navigationParentId } from "../lib/tree";
import { DetailLink } from "./DetailLink";
import classes from "./DetailTable.module.css";
import selectionClasses from "./EntitySelection.module.css";
import { useInspectionMenuTarget } from "./InspectionMenu";
import { useSessionInteraction } from "./SessionInteraction";
import { ToolExecutionDetails } from "./ToolExecutionDetails";

export function ToolExecutionRow({
  execution,
  offset,
  expanded,
  onToggle,
  onJumpToCall,
  legacySelected = false,
}: {
  execution: ToolExecution;
  offset: number | null;
  expanded: boolean;
  onToggle: () => void;
  onJumpToCall: (ref: CallRef) => void;
  legacySelected?: boolean;
}) {
  const interaction = useSessionInteraction();
  const subject = execution.subject;
  const subjectRef =
    subject && interaction && uniqueNodeId(interaction.root, subject.node_id)
      ? { kind: "node" as const, sessionId: interaction.sessionId, nodeId: subject.node_id }
      : null;
  const selected =
    legacySelected || (subjectRef !== null && sameEntity(interaction?.location.selection ?? null, subjectRef));
  const localKey = execution.key;
  const localSelected =
    interaction?.localMark?.viewKey === `tool-execution:${execution.ownerId}` && interaction.localMark.key === localKey;
  const menuTarget = useInspectionMenuTarget((_target) => {
    if (interaction === null) return [];
    const actions = [];
    if (subjectRef)
      actions.push({ id: "details", label: "Show details", run: () => interaction.openEntity(subjectRef) });
    else actions.push({ id: "details", label: expanded ? "Hide evidence" : "Show evidence", run: onToggle });
    if (subjectRef && subject) {
      const parent = navigationParentId(interaction.root, subject.node_id);
      if (parent) actions.push({ id: "parent", label: "Show parent agent", run: () => interaction.openNode(parent) });
      actions.push({ id: "copy-link", label: "Copy link", run: () => interaction.copyLink(subjectRef) });
    }
    const requester = recordedCallTargets(interaction.root, interaction.sessionId, execution.events, "requested_by");
    const consumer = recordedCallTargets(interaction.root, interaction.sessionId, execution.events, "consumed_by");
    const callLabel = (ref: (typeof requester)[number]) => {
      const resolved = resolveEntity(interaction.root, interaction.sessionId, ref);
      return resolved !== null && resolved.call !== null && resolved.index !== null
        ? `${ref.ownerId} · ${resolved.node.topic} · LLM call ${resolved.index + 1}`
        : `${ref.ownerId} · ${ref.callKey}`;
    };
    for (const ref of requester)
      actions.push({
        id: `request:${JSON.stringify([ref.ownerId, ref.callKey])}`,
        label: `Show requesting call: ${callLabel(ref)}`,
        run: () => interaction.openEntity(ref),
      });
    for (const ref of consumer)
      actions.push({
        id: `consumer:${JSON.stringify([ref.ownerId, ref.callKey])}`,
        label: `Show consuming call: ${callLabel(ref)}`,
        run: () => interaction.openEntity(ref),
      });
    return actions;
  });
  const mark = () => {
    if (!interaction) return;
    if (subjectRef) interaction.selectEntity(subjectRef);
    else interaction.markLocal(`tool-execution:${execution.ownerId}`, localKey);
  };
  const name = toolExecutionName(execution);
  return (
    <>
      <Table.Tr
        data-testid={`tool-execution-${execution.ownerId}-${execution.key}`}
        className={selectionClasses.item}
        data-selection={selected || localSelected ? "exact" : "none"}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button,a,input,summary")) return;
          mark();
        }}
        {...menuTarget}
        onKeyDown={(event) => {
          menuTarget.onKeyDown(event);
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            mark();
          }
        }}
        tabIndex={0}
      >
        <Table.Td data-label="Time">
          <Group gap={4} wrap="nowrap">
            <ActionIcon
              size="xs"
              variant="subtle"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
              aria-expanded={expanded}
              onClick={onToggle}
            >
              {expanded ? "▾" : "▸"}
            </ActionIcon>
            <Text size="xs">{formatTimestamp(execution.startMs)}</Text>
            <Text size="xs" c="dimmed">
              {offset === null ? MISSING : `+${formatDuration(offset)}`}
            </Text>
          </Group>
        </Table.Td>
        <Table.Td data-label="Item">
          <Group gap={4} wrap="nowrap">
            <Text size="xs" className={classes.topic}>
              <DetailLink
                label={name}
                entityRef={subjectRef}
                onOpen={() => {
                  if (subjectRef !== null) interaction?.openEntity(subjectRef);
                  else if (!expanded) onToggle();
                }}
              >
                {name}
              </DetailLink>
            </Text>
            {execution.success === false && (
              <Badge size="xs" color="red">
                failed
              </Badge>
            )}
            {execution.success === true && (
              <Badge size="xs" color="green">
                success
              </Badge>
            )}
          </Group>
        </Table.Td>
        <Table.Td data-label="Duration">
          <Text size="xs">
            {execution.duration.value === null ? "Unavailable" : formatDuration(execution.duration.value)}
          </Text>
        </Table.Td>
        <Table.Td data-label="Cost">
          <Text size="xs" c="dimmed">
            —
          </Text>
        </Table.Td>
        <Table.Td data-label="Tokens">
          <Text size="xs" c="dimmed">
            —
          </Text>
        </Table.Td>
      </Table.Tr>
      {expanded && (
        <Table.Tr>
          <Table.Td colSpan={5} data-detail>
            <ToolExecutionDetails execution={execution} subjectRef={subjectRef} onJumpToCall={onJumpToCall} />
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}

function uniqueNodeId(root: NodeOut, nodeId: string): boolean {
  let matches = 0;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (node.node_id === nodeId && ++matches > 1) return false;
    stack.push(...node.children);
  }
  return matches === 1;
}
