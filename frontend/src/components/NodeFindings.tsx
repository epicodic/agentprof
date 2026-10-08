// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Badge, Box, Button, Code, Group, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import type { FindingOut } from "../api/types";
import { findingGroups } from "../lib/findingGroups";
import { formatCost, withProvenance } from "../lib/format";
import { severityColor } from "../lib/severity";

export function NodeFindings({ findings }: { findings: FindingOut[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [expandedEvidence, setExpandedEvidence] = useState<Set<string>>(() => new Set());
  if (findings.length === 0) return null;

  const toggle = (key: string, update: (value: Set<string>) => void, current: Set<string>) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    update(next);
  };

  return (
    <Stack gap={4}>
      <Title order={5}>Findings ({findings.length})</Title>
      {findingGroups(findings).map((group) => {
        const isExpanded = expanded.has(group.key);
        return (
          <Box key={group.key} data-testid={`finding-group-${group.heuristicId}`}>
            <Group gap="xs" wrap="nowrap" align="center">
              <Button
                type="button"
                variant="subtle"
                size="compact-xs"
                aria-label={`${isExpanded ? "Collapse" : "Expand"} ${group.heuristicId} findings`}
                aria-expanded={isExpanded}
                onClick={() => toggle(group.key, setExpanded, expanded)}
                style={{ minWidth: 24, paddingInline: 4 }}
              >
                <span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
              </Button>
              <Group gap="xs" wrap="nowrap">
                <Badge size="xs" color={severityColor(group.severity)}>
                  {group.heuristicId}
                </Badge>
                <Text size="xs">
                  {group.items.length} {group.items.length === 1 ? "finding" : "findings"}
                </Text>
              </Group>
            </Group>
            {isExpanded && (
              <Stack gap="xs" mt="xs" ml="md">
                {group.items.map((finding, index) => {
                  const key = `${group.key}:${index}`;
                  const hasEvidence = Object.keys(finding.evidence).length > 0;
                  const evidenceIsExpanded = expandedEvidence.has(key);
                  return (
                    <Stack key={key} gap={4}>
                      <Text size="sm" style={{ overflowWrap: "anywhere" }}>
                        {finding.message}
                      </Text>
                      {finding.estimated_avoidable_cost.value !== null && (
                        <Text size="xs" c="dimmed">
                          Estimated avoidable cost:{" "}
                          {withProvenance(
                            formatCost(finding.estimated_avoidable_cost),
                            finding.estimated_avoidable_cost,
                          )}
                        </Text>
                      )}
                      {hasEvidence && (
                        <>
                          <Group gap="xs">
                            <Button
                              type="button"
                              variant="subtle"
                              size="compact-xs"
                              aria-label={`${evidenceIsExpanded ? "Collapse" : "Expand"} evidence`}
                              aria-expanded={evidenceIsExpanded}
                              onClick={() => toggle(key, setExpandedEvidence, expandedEvidence)}
                              style={{ minWidth: 24, paddingInline: 4 }}
                            >
                              <span aria-hidden="true">{evidenceIsExpanded ? "▾" : "▸"}</span>
                            </Button>
                            <Text size="xs">Evidence</Text>
                          </Group>
                          {evidenceIsExpanded && (
                            <Code
                              block
                              style={{
                                whiteSpace: "pre-wrap",
                                overflowWrap: "anywhere",
                                maxHeight: 400,
                                overflow: "auto",
                              }}
                            >
                              {JSON.stringify(finding.evidence, null, 2)}
                            </Code>
                          )}
                        </>
                      )}
                    </Stack>
                  );
                })}
              </Stack>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}
