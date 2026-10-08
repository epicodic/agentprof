// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Badge, Group, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import type { NodeDetailOut, NodeOut, TokensOut } from "../api/types";
import { costEvents, costSum } from "../lib/cost";
import {
  formatCost,
  formatDuration,
  formatTimestamp,
  formatTokens,
  MISSING,
  truncateTitle,
  withProvenance,
} from "../lib/format";

function count(value: NodeOut["llm_call_count"]): string {
  return value.value === null ? MISSING : withProvenance(String(value.value), value);
}

function duration(value: NodeOut["duration"]): string {
  return withProvenance(formatDuration(value.value), value);
}

export function NodeOverview({ node, detail }: { node: NodeOut; detail: NodeDetailOut | undefined }) {
  const events = node.kind === "session" ? costEvents(node) : null;
  const ownCost = events === null ? node.cost_own : costSum(events);
  const callCount = events === null ? count(node.llm_call_count) : String(events.length);
  const figures: { label: string; value: string; testId?: string }[] = [
    { label: "Duration", value: duration(node.duration) },
    { label: "Own cost", value: withProvenance(formatCost(ownCost), ownCost), testId: "metrics-cost-own" },
    {
      label: "Including descendants",
      value: withProvenance(formatCost(node.cost_total), node.cost_total),
    },
    { label: "LLM calls", value: callCount, testId: "metrics-llm-calls" },
    { label: "Tool calls", value: count(node.tool_call_count) },
  ];
  const tokenRows: [string, keyof TokensOut][] = [
    ["Input", "input"],
    ["Output", "output"],
    ["Cache read", "cache_read"],
    ["Cache write", "cache_write"],
    ["Cache write 5m", "cache_write_5m"],
    ["Cache write 1h", "cache_write_1h"],
  ];

  return (
    <Stack gap="sm">
      <Title order={5}>Task</Title>
      <Text size="sm" title={node.topic} style={{ overflowWrap: "anywhere" }}>
        {truncateTitle(node.topic)}
      </Text>
      {node.success !== null && (
        <Badge color={node.success ? "green" : "red"}>{node.success ? "Succeeded" : "Failed"}</Badge>
      )}
      {detail !== undefined && (
        <Group align="start">
          {detail.prompt !== "" && (
            <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
              <Text c="dimmed" size="xs">
                Prompt preview
              </Text>
              <Text size="sm" lineClamp={3} style={{ overflowWrap: "anywhere" }}>
                {detail.prompt}
              </Text>
            </Stack>
          )}
          {detail.result !== "" && (
            <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
              <Text c="dimmed" size="xs">
                Result preview
              </Text>
              <Text size="sm" lineClamp={3} style={{ overflowWrap: "anywhere" }}>
                {detail.result}
              </Text>
            </Stack>
          )}
        </Group>
      )}
      <SimpleGrid cols={{ base: 2, sm: 3 }}>
        {figures.map(({ label, value, testId }) => (
          <Stack gap={2} key={label}>
            <Text c="dimmed" size="xs">
              {label}
            </Text>
            <Text size="sm" data-testid={testId}>
              {value}
            </Text>
          </Stack>
        ))}
      </SimpleGrid>
      <section>
        <Title order={5}>Metric details</Title>
        <Table withRowBorders={false}>
          <Table.Tbody>
            <Table.Tr>
              <Table.Th>Start</Table.Th>
              <Table.Td>{withProvenance(formatTimestamp(node.start.value), node.start)}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Th>User wait</Table.Th>
              <Table.Td>{duration(node.user_wait)}</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
        <Table data-testid="metrics-tokens">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Tokens</Table.Th>
              <Table.Th>Own</Table.Th>
              <Table.Th>Including descendants</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {tokenRows.map(([label, key]) => (
              <Table.Tr key={key}>
                <Table.Th>{label}</Table.Th>
                <Table.Td>{withProvenance(formatTokens(node.tokens[key].value), node.tokens[key])}</Table.Td>
                <Table.Td>
                  {withProvenance(formatTokens(node.tokens_total[key].value), node.tokens_total[key])}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </section>
    </Stack>
  );
}
