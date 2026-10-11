// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Button, Code, Group, Stack, Text } from "@mantine/core";
import { useState } from "react";
import type { FindingOut, NodeOut } from "../api/types";
import type { EntityRef } from "../lib/entities";
import { resolveFindingReference } from "../lib/findingReferences";
import { formatCost, withProvenance } from "../lib/format";
import { DetailLink } from "./DetailLink";

interface Props {
  finding: FindingOut;
  root: NodeOut | null;
  sessionId: string | null;
  onInspect?: (ref: EntityRef) => void;
  evidenceExpanded?: boolean;
  onToggleEvidence?: () => void;
}

function costQualifier(agent: string, unit: string | null): string {
  if (agent === "copilot-vscode") return unit === "credits" ? "recorded Copilot credits" : "reported Copilot billing";
  if (agent === "codex") return "API-equivalent USD estimate";
  if (agent === "claude-code") return "Claude pricing estimate";
  return "reported cost";
}

export function FindingEvidence({ finding, root, sessionId, onInspect, evidenceExpanded, onToggleEvidence }: Props) {
  const [localEvidenceExpanded, setLocalEvidenceExpanded] = useState(false);
  const hasObservedCost = finding.observed_cost !== undefined && finding.observed_cost.value !== null;
  const baseline = finding.avoidable_cost_baseline;
  const hasBaseline = typeof baseline === "string" && baseline.trim() !== "";
  const hasAvoidableCost = finding.estimated_avoidable_cost.value !== null;
  const references = finding.references ?? [];
  const uniqueReferences = [...new Map(references.map((reference) => [JSON.stringify(reference), reference])).values()];
  const hasRawEvidence = Object.keys(finding.evidence).length > 0;
  const expanded = evidenceExpanded ?? localEvidenceExpanded;
  const toggleEvidence = onToggleEvidence ?? (() => setLocalEvidenceExpanded((value) => !value));
  const agent = sessionId?.split(":", 1)[0] ?? "";

  return (
    <Stack gap={4}>
      {hasObservedCost && finding.observed_cost !== undefined && (
        <Text size="xs" c="dimmed">
          Observed cost category sum ({costQualifier(agent, finding.observed_cost.unit)}):{" "}
          {withProvenance(formatCost(finding.observed_cost), finding.observed_cost)}
        </Text>
      )}
      {!hasBaseline ? (
        <Text size="xs" c="dimmed">
          Avoidable cost unavailable: baseline unavailable
        </Text>
      ) : hasAvoidableCost ? (
        <Text size="xs" c="dimmed">
          Estimated avoidable cost (baseline: {baseline}; {costQualifier(agent, finding.estimated_avoidable_cost.unit)}
          ): {withProvenance(formatCost(finding.estimated_avoidable_cost), finding.estimated_avoidable_cost)}
        </Text>
      ) : (
        <Text size="xs" c="dimmed">
          Estimated avoidable cost unavailable against baseline: {baseline}
        </Text>
      )}
      {uniqueReferences.length > 0 && (
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            Supporting references
          </Text>
          <Group gap="xs" wrap="wrap">
            {uniqueReferences.map((reference) => {
              const entityRef =
                root === null || sessionId === null ? null : resolveFindingReference(root, sessionId, reference);
              const key = JSON.stringify(reference);
              return entityRef === null ? (
                <Text key={key} size="xs" c="dimmed">
                  {reference.label} (unavailable)
                </Text>
              ) : (
                <DetailLink
                  key={key}
                  label={reference.label}
                  entityRef={entityRef}
                  onOpen={onInspect === undefined ? undefined : () => onInspect(entityRef)}
                >
                  {reference.label}
                </DetailLink>
              );
            })}
          </Group>
        </Stack>
      )}
      {hasRawEvidence && (
        <>
          <Group gap="xs">
            <Button
              type="button"
              variant="subtle"
              size="compact-xs"
              aria-label={`${expanded ? "Collapse" : "Expand"} evidence`}
              aria-expanded={expanded}
              onClick={(event) => {
                event.stopPropagation();
                toggleEvidence();
              }}
              style={{ minWidth: 24, paddingInline: 4 }}
            >
              <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
            </Button>
            <Text size="xs">Evidence</Text>
          </Group>
          {expanded && (
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
}
