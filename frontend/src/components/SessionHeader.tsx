// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Alert, Anchor, Badge, Button, Group, Stack, Switch, Text, Title } from "@mantine/core";
import { Link } from "react-router";
import type { SessionOut } from "../api/types";
import {
  agentLabel,
  formatCost,
  formatDuration,
  formatTokens,
  MISSING,
  totalTokens,
  truncateTitle,
  withProvenance,
} from "../lib/format";
import { countLlmCalls, countToolCalls } from "../lib/tree";
import classes from "./SessionHeader.module.css";

interface Props {
  session: SessionOut;
  fetchedAtMs?: number;
  latestObservedAtMs?: number | null;
  findingCount: number;
  findingsOnly: boolean;
  onFindingsOnly: (value: boolean) => void;
  onOpenFindings: () => void;
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <Stack gap={0}>
      <Text size="10px" tt="uppercase" c="dimmed">
        {label}
      </Text>
      <Text size="sm">{value}</Text>
    </Stack>
  );
}

function freshness(value: number | null | undefined, multiplier = 1): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "Unavailable";
  const timestamp = value * multiplier;
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 8.64e15) return "Unavailable";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  }).format(date);
}

function warningsOf(session: SessionOut): string[] {
  const unknown = Object.entries(session.diagnostics.unknown_tool_ids);
  const warnings = [...session.diagnostics.warnings];
  if (session.diagnostics.malformed_lines > 0) {
    warnings.push(`${session.diagnostics.malformed_lines} malformed lines skipped`);
  }
  if (unknown.length > 0) {
    warnings.push(`Unknown tools: ${unknown.map(([name, count]) => `${name} ×${count}`).join(", ")}`);
  }
  return warnings;
}

export function SessionHeader({
  session,
  fetchedAtMs,
  latestObservedAtMs,
  findingCount,
  findingsOnly,
  onFindingsOnly,
  onOpenFindings,
}: Props) {
  const root = session.root;
  const warnings = warningsOf(session);
  return (
    <Stack gap={6} className={classes.header}>
      <Group justify="space-between" className={classes.identityRow}>
        <Group gap="xs" className={classes.identity}>
          <Anchor component={Link} to="/" size="sm" className={classes.sessionsLink}>
            ← Sessions
          </Anchor>
          <Title order={3} lineClamp={1} className={classes.title}>
            <span title={session.title}>{truncateTitle(session.title)}</span>
          </Title>
          <Badge variant="light">{agentLabel(session.agent)}</Badge>
          {session.sources.map((source) => (
            <Badge key={source} variant="outline" size="sm">
              {source}
            </Badge>
          ))}
        </Group>
        <Group gap="xs" className={classes.controls}>
          <Switch
            size="xs"
            label="Only rows with findings"
            checked={findingsOnly}
            onChange={(event) => onFindingsOnly(event.currentTarget.checked)}
          />
          <Button size="xs" variant="light" color="orange" onClick={onOpenFindings} disabled={findingCount === 0}>
            Findings ({findingCount})
          </Button>
        </Group>
      </Group>
      <Group gap="lg" className={classes.figures}>
        <Figure label="Workspace" value={session.workspace ?? MISSING} />
        <Figure label="Duration" value={withProvenance(formatDuration(root.duration.value), root.duration)} />
        <Figure label="Cost" value={withProvenance(formatCost(root.cost_total), root.cost_total)} />
        <Figure label="Tokens" value={formatTokens(totalTokens(root.tokens_total))} />
        <Figure label="LLM calls" value={String(countLlmCalls(root))} />
        <Figure label="Tool calls" value={String(countToolCalls(root))} />
        <Figure label="Source updated" value={freshness(session.mtime, 1000)} />
        <Figure label="Fetched" value={freshness(fetchedAtMs)} />
        <Figure label="Latest observed activity" value={freshness(latestObservedAtMs)} />
      </Group>
      {warnings.length > 0 && (
        <Alert color="yellow" p="xs" className={classes.warnings}>
          {warnings.map((warning) => (
            <Text key={warning} size="xs">
              {warning}
            </Text>
          ))}
        </Alert>
      )}
    </Stack>
  );
}
