// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Stack, Table, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";
import type { CostOut, MetricOut, NodeOut } from "../api/types";
import { type CacheCostCategory, type CacheProjection, cacheAnalysis } from "../lib/cache";
import { formatCost, formatTokens, withProvenance } from "../lib/format";

interface Props {
  node: NodeOut;
  agent: string;
}

function metricValue(value: MetricOut): string {
  return withProvenance(formatTokens(value.value), value);
}

function costValue(value: CostOut): string {
  return withProvenance(formatCost(value), value);
}

function coverageText(coverage: { known: number; total: number }): string {
  return `${coverage.known}/${coverage.total} calls covered`;
}

function measuredValue(value: MetricOut, coverage: { known: number; total: number }, testId: string): ReactNode {
  return (
    <>
      <span data-testid={testId} style={{ whiteSpace: "nowrap" }}>
        {metricValue(value)}
      </span>
      {coverage.known < coverage.total && (
        <Text component="span" size="xs" c="dimmed">
          {` (${coverage.known}/${coverage.total} calls measured)`}
        </Text>
      )}
    </>
  );
}

export function CacheSection({ node, agent }: Props) {
  const analysis = cacheAnalysis(node, agent);
  const quantityRows: [string, CacheProjection<MetricOut>, keyof typeof analysis.quantityCoverage][] = [
    ["Cache read", analysis.cacheRead, "cache_read"],
    ["Cache write", analysis.cacheWrite, "cache_write_total"],
    ["Cache write 5m (subset)", analysis.cacheWrite5m, "cache_write_5m"],
    ["Cache write 1h (subset)", analysis.cacheWrite1h, "cache_write_1h"],
  ];
  const costRows: [string, CacheCostCategory][] = [
    ["Cache read", "cache_read"],
    ["Cache write 5m", "cache_write_5m"],
    ["Cache write 1h", "cache_write_1h"],
    ["Cache write total", "cache_write"],
  ];
  const rewriteOwnCount = analysis.rewriteCount.own.value ?? 0;
  const rewriteInclusiveCount = analysis.rewriteCount.inclusive.value ?? 0;
  const categoryQualifier =
    analysis.costQualifier === "Recorded credits" ? "Unavailable from recorded credits" : analysis.costQualifier;

  return (
    <section data-testid="cache-analysis">
      <Stack gap="xs">
        <Title order={5}>Cache and overhead</Title>
        <Text size="xs" c="dimmed">
          Cache write 5m and 1h values are subsets of total cache write.
        </Text>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Cache quantity (tokens)</Table.Th>
              <Table.Th>Own</Table.Th>
              <Table.Th>Including descendants</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {quantityRows.map(([label, value, category]) => (
              <Table.Tr key={label}>
                <Table.Th>{label}</Table.Th>
                <Table.Td>
                  {measuredValue(value.own, analysis.quantityCoverage[category].own, `cache-value-${category}-own`)}
                </Table.Td>
                <Table.Td>
                  {measuredValue(
                    value.inclusive,
                    analysis.quantityCoverage[category].inclusive,
                    `cache-value-${category}-inclusive`,
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Text size="xs" c="dimmed">
          Category cost parts · {categoryQualifier}
        </Text>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Category cost</Table.Th>
              <Table.Th>Own</Table.Th>
              <Table.Th>Including descendants</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {costRows.map(([label, category]) => {
              const costs = analysis.categoryCosts[category];
              const coverage = analysis.categoryCosts.coverage[category];
              return (
                <Table.Tr key={category}>
                  <Table.Th>{label}</Table.Th>
                  <Table.Td>
                    <span style={{ whiteSpace: "nowrap" }}>{costValue(costs.own)}</span>{" "}
                    <Text component="span" size="xs" c="dimmed">
                      ({coverageText(coverage.own)})
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <span style={{ whiteSpace: "nowrap" }}>{costValue(costs.inclusive)}</span>{" "}
                    <Text component="span" size="xs" c="dimmed">
                      ({coverageText(coverage.inclusive)})
                    </Text>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
        <Table>
          <Table.Tbody>
            <Table.Tr>
              <Table.Th>{analysis.callCostLabel}</Table.Th>
              <Table.Td>
                <span style={{ whiteSpace: "nowrap" }}>{costValue(analysis.callCostSubtotal.own)}</span>{" "}
                <Text component="span" size="xs" c="dimmed">
                  ({coverageText(analysis.callCostCoverage.own)})
                </Text>
              </Table.Td>
              <Table.Td>
                <span style={{ whiteSpace: "nowrap" }}>{costValue(analysis.callCostSubtotal.inclusive)}</span>{" "}
                <Text component="span" size="xs" c="dimmed">
                  ({coverageText(analysis.callCostCoverage.inclusive)})
                </Text>
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Th>{analysis.recordedCostLabel} (own)</Table.Th>
              <Table.Td>
                <span style={{ whiteSpace: "nowrap" }}>{costValue(analysis.recordedCost.own)}</span>
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Th>{analysis.recordedCostLabel} (including descendants)</Table.Th>
              <Table.Td>
                <span style={{ whiteSpace: "nowrap" }}>{costValue(analysis.recordedCost.inclusive)}</span>
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Th>Cold cache rewrites</Table.Th>
              <Table.Td>{metricValue(analysis.rewriteCount.own)}</Table.Td>
              <Table.Td>{metricValue(analysis.rewriteCount.inclusive)}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Th>Cold rewrite write cost</Table.Th>
              <Table.Td>
                {rewriteOwnCount === 0
                  ? "No own cold rewrites observed"
                  : `${costValue(analysis.rewriteWriteCost.own)} (${coverageText(analysis.rewriteWriteCoverage.own)})`}
              </Table.Td>
              <Table.Td>
                {rewriteInclusiveCount === 0
                  ? "No cold rewrites observed"
                  : `${costValue(analysis.rewriteWriteCost.inclusive)} (${coverageText(analysis.rewriteWriteCoverage.inclusive)})`}
              </Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
        {agent === "claude-code" && (
          <Text size="xs" c="dimmed">
            Recorded node totals may include aggregate billing beyond the call-level category estimates.
          </Text>
        )}
        {analysis.costQualifier === "Recorded credits" && (
          <Text size="xs" c="dimmed">
            Copilot credits are recorded as totals; cache category costs and rewrite costs are unavailable.
          </Text>
        )}
        {agent === "codex" && (
          <Stack gap={0}>
            <Text size="xs" c="dimmed">
              Codex node totals are API-equivalent USD estimates; the call subtotal is independently summed from call
              usage.
            </Text>
            <Text size="xs" c="dimmed">
              API-equivalent totals use 5m write pricing; recorded write TTL is unavailable.
            </Text>
          </Stack>
        )}
      </Stack>
    </section>
  );
}
