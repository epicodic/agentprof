// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { ActionIcon, Group, Table, Text } from "@mantine/core";
import { formatDuration, formatTimestamp, MISSING, truncateTitle, withProvenance } from "../lib/format";
import { type ToolExecution, toolExecutionName } from "../lib/toolExecutions";
import classes from "./DetailTable.module.css";

export function ToolGroupRow({
  ownerId,
  index,
  executions,
  sourceCount,
  expanded,
  onToggle,
}: {
  ownerId: string;
  index: number;
  executions: readonly ToolExecution[];
  sourceCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const starts = executions.map((execution) => execution.startMs ?? execution.resultMs).filter(isFiniteNumber);
  const ends = executions.map((execution) => execution.resultMs ?? execution.startMs).filter(isFiniteNumber);
  const first = starts.length === 0 ? null : Math.min(...starts);
  const last = ends.length === 0 ? null : Math.max(...ends);
  const elapsed = first !== null && last !== null && last >= first ? last - first : null;
  const durations = executions.map((execution) => execution.duration);
  const executionTotal = durations.every((duration) => duration.value !== null)
    ? {
        value: durations.reduce((sum, duration) => sum + (duration.value ?? 0), 0),
        provenance: durations.some((duration) => duration.provenance === "estimated") ? "estimated" : "exact",
      }
    : null;
  const key = JSON.stringify(executions.map((execution) => execution.key));
  return (
    <>
      <Table.Tr data-testid={`tool-group-${ownerId}-${index}`} data-group-key={key}>
        <Table.Td data-label="Time">
          <Group gap={4} wrap="nowrap">
            <ActionIcon
              size="xs"
              variant="subtle"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${toolCountLabel(executions.length, sourceCount)}`}
              aria-expanded={expanded}
              onClick={onToggle}
            >
              {expanded ? "▾" : "▸"}
            </ActionIcon>
            <Text size="xs">{formatTimestamp(first)}</Text>
          </Group>
        </Table.Td>
        <Table.Td data-label="Item">
          <Text size="xs" className={classes.topic} title={[...new Set(executions.map(toolExecutionName))].join(", ")}>
            {truncateTitle([...new Set(executions.map(toolExecutionName))].join(", "))}
          </Text>
        </Table.Td>
        <Table.Td data-label="Duration" ta="right">
          <Text size="xs">{elapsed === null ? MISSING : formatDuration(elapsed)}</Text>
        </Table.Td>
        <Table.Td data-label="Cost" />
        <Table.Td data-label="Tokens" />
      </Table.Tr>
      {expanded && (
        <Table.Tr>
          <Table.Td colSpan={5} data-detail data-testid={`tool-group-metrics-${ownerId}-${index}`}>
            <Text size="xs">
              {toolCountLabel(executions.length, sourceCount)} · Elapsed{" "}
              {elapsed === null ? MISSING : formatDuration(elapsed)} · Execution total{" "}
              {executionTotal === null ? MISSING : withProvenance(formatDuration(executionTotal.value), executionTotal)}
            </Text>
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}

function toolCountLabel(visibleCount: number, sourceCount: number): string {
  return `${visibleCount === sourceCount ? visibleCount : `${visibleCount} of ${sourceCount}`} tools`;
}

function isFiniteNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}
