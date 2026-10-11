// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Badge, Box, Button, Group, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import type { FindingOut } from "../api/types";
import { findingGroups } from "../lib/findingGroups";
import { severityColor } from "../lib/severity";
import { FindingEvidence } from "./FindingEvidence";
import { useSessionInteraction } from "./SessionInteraction";

export function NodeFindings({ findings }: { findings: FindingOut[] }) {
  const interaction = useSessionInteraction();
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
                  const evidenceIsExpanded = expandedEvidence.has(key);
                  return (
                    <Stack key={key} gap={4}>
                      <Text size="sm" style={{ overflowWrap: "anywhere" }}>
                        {finding.message}
                      </Text>
                      <FindingEvidence
                        finding={finding}
                        root={interaction?.root ?? null}
                        sessionId={interaction?.sessionId ?? null}
                        evidenceExpanded={evidenceIsExpanded}
                        onToggleEvidence={() => toggle(key, setExpandedEvidence, expandedEvidence)}
                      />
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
