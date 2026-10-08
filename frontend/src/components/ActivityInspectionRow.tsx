// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { ActionIcon, Group, Table, Text } from "@mantine/core";
import type { ExecutionEventOut } from "../api/types";
import type { EventRef } from "../lib/entities";
import { formatTimestamp, MISSING } from "../lib/format";
import { DetailLink } from "./DetailLink";
import selectionClasses from "./EntitySelection.module.css";
import { useInspectionMenuTarget } from "./InspectionMenu";
import { useSessionInteraction } from "./SessionInteraction";
import { SourceEvidence } from "./ToolExecutionDetails";

export function ActivityInspectionRow({
  event,
  eventRef,
  selected,
  localSelected,
  expanded,
  onMark,
  onToggle,
}: {
  event: ExecutionEventOut;
  eventRef: EventRef | null;
  selected: boolean;
  localSelected: boolean;
  expanded: boolean;
  onMark: () => void;
  onToggle: () => void;
}) {
  const interaction = useSessionInteraction();
  const menuTarget = useInspectionMenuTarget(() => [
    {
      id: "details",
      label: eventRef ? "Show details" : "Show evidence",
      run: () => (eventRef ? interaction?.openEntity(eventRef) : onToggle()),
    },
    ...(eventRef && interaction ? [{ id: "copy", label: "Copy link", run: () => interaction.copyLink(eventRef) }] : []),
  ]);
  return (
    <>
      <Table.Tr
        tabIndex={0}
        className={selectionClasses.item}
        data-selection={selected || localSelected ? "exact" : "none"}
        {...menuTarget}
        onClick={(e) => {
          if (e.target instanceof Element && e.target.closest("button,a,input")) return;
          onMark();
        }}
        onKeyDown={(e) => {
          menuTarget.onKeyDown(e);
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onMark();
          }
        }}
      >
        <Table.Td data-label="Time">
          <Group gap={4} wrap="nowrap">
            <ActionIcon
              size="xs"
              variant="subtle"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${event.kind}`}
              aria-expanded={expanded}
              onClick={onToggle}
            >
              {expanded ? "▾" : "▸"}
            </ActionIcon>
            <Text size="xs">{formatTimestamp(event.start.value)}</Text>
          </Group>
        </Table.Td>
        <Table.Td data-label="Item">
          <Text size="xs">
            <DetailLink
              label={event.kind.replaceAll("_", " ")}
              entityRef={eventRef}
              onOpen={() => {
                if (eventRef !== null) interaction?.openEntity(eventRef);
                else if (!expanded) onToggle();
              }}
            >
              {event.kind.replaceAll("_", " ")}
            </DetailLink>
          </Text>
        </Table.Td>
        <Table.Td data-label="Duration">
          <Text size="xs" c="dimmed">
            {MISSING}
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
            <SourceEvidence events={[event]} />
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}
