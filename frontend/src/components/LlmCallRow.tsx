// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { ActionIcon, Group, Table, Text } from "@mantine/core";
import type { LlmCallOut } from "../api/types";
import type { EntityRef } from "../lib/entities";
import {
  formatCost,
  formatDuration,
  formatTimestamp,
  formatTokens,
  MISSING,
  totalTokens,
  withProvenance,
} from "../lib/format";
import { colorForMetric, type MetricScale } from "../lib/metricColor";
import { DetailLink } from "./DetailLink";
import tableClasses from "./DetailTable.module.css";
import selectionClasses from "./EntitySelection.module.css";
import { useInspectionMenuTarget } from "./InspectionMenu";
import { useSessionInteraction } from "./SessionInteraction";

const tokenText = (value: { value: number | null; provenance: string }) =>
  withProvenance(formatTokens(value.value), value);

export function LlmCallRow({
  ownerId,
  index,
  call,
  callRef,
  expanded,
  focused,
  selected,
  offset,
  durationScale,
  costScale,
  onToggle,
  onSelect,
  onMarkLocal,
  localSelected,
}: {
  ownerId: string;
  index: number;
  call: LlmCallOut;
  callRef: Extract<EntityRef, { kind: "call" }> | null;
  expanded: boolean;
  focused: boolean;
  selected: boolean;
  offset: number | null;
  durationScale: MetricScale | null;
  costScale: MetricScale | null;
  onToggle: () => void;
  onSelect: () => void;
  onMarkLocal: () => void;
  localSelected: boolean;
}) {
  const interaction = useSessionInteraction();
  const fullTokens = [
    ["Input", call.tokens.input],
    ["Cache read", call.tokens.cache_read],
    ["Cache write", call.tokens.cache_write],
    ["Cache write 5m", call.tokens.cache_write_5m],
    ["Cache write 1h", call.tokens.cache_write_1h],
    ["Output", call.tokens.output],
  ] as const;
  const showDetails = () => {
    if (!expanded) onToggle();
  };
  const menuTarget = useInspectionMenuTarget(() => [
    { id: "details", label: "Show details", run: showDetails },
    ...(callRef && interaction ? [{ id: "copy", label: "Copy link", run: () => interaction.copyLink(callRef) }] : []),
  ]);
  return (
    <>
      <Table.Tr
        data-focused={focused || undefined}
        data-testid={`call-cost-${ownerId}-${index}`}
        className={selectionClasses.item}
        data-selection={selected || localSelected ? "exact" : "none"}
        tabIndex={0}
        {...menuTarget}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button,a,input,summary")) return;
          if (callRef !== null) onSelect();
          else onMarkLocal();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          menuTarget.onKeyDown(event);
          if (event.defaultPrevented) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (callRef !== null) onSelect();
            else onMarkLocal();
          }
        }}
      >
        <Table.Td data-label="Time">
          <Group gap={4} wrap="nowrap">
            <ActionIcon
              size="xs"
              variant="subtle"
              aria-label={`${expanded ? "Collapse" : "Expand"} LLM call ${index + 1}`}
              aria-expanded={expanded}
              onClick={onToggle}
            >
              {expanded ? "▾" : "▸"}
            </ActionIcon>
            <Text size="xs">{formatTimestamp(call.start.value)}</Text>
            <Text size="xs" c="dimmed">
              {offset === null ? MISSING : `+${formatDuration(offset)}`}
            </Text>
          </Group>
        </Table.Td>
        <Table.Td data-label="Item">
          <Text size="xs">
            <DetailLink
              label={`LLM call ${index + 1}`}
              entityRef={callRef}
              onOpen={() => {
                if (callRef !== null && interaction !== null) interaction.openEntity(callRef);
                else showDetails();
              }}
            >
              LLM call {index + 1}
            </DetailLink>
          </Text>
        </Table.Td>
        <Table.Td data-label="Duration">
          <Text size="xs" c={colorForMetric(call.duration.value, durationScale) ?? undefined}>
            {withProvenance(formatDuration(call.duration.value), call.duration)}
          </Text>
        </Table.Td>
        <Table.Td data-label="Cost">
          <Text size="xs" c={colorForMetric(call.cost.usd, costScale) ?? undefined}>
            {withProvenance(formatCost(call.cost), call.cost)}
          </Text>
        </Table.Td>
        <Table.Td data-label="Tokens">
          <Text size="xs">{formatTokens(totalTokens(call.tokens))}</Text>
        </Table.Td>
      </Table.Tr>
      {expanded && (
        <Table.Tr>
          <Table.Td colSpan={5} data-detail>
            <dl className={tableClasses.mobileMetrics} data-testid={`mobile-call-metrics-${ownerId}-${index}`}>
              {[
                ["Since start", offset === null ? MISSING : `+${formatDuration(offset)}`],
                ...fullTokens.map(([label, value]) => [label, tokenText(value)] as [string, string]),
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <CallDetails call={call} />
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}

function CallDetails({ call }: { call: LlmCallOut }) {
  return (
    <div>
      <Text size="xs">Model: {call.model ?? MISSING}</Text>
      {call.call_id && <Text size="xs">Call ID: {call.call_id}</Text>}
      {call.timing_basis !== "request_start" && (
        <Text size="xs" c="dimmed">
          Timing basis: {call.timing_basis.replaceAll("_", " ")}
        </Text>
      )}
      {Object.entries(call.cost_parts).length > 0 && (
        <Text size="xs">
          Cost parts:{" "}
          {Object.entries(call.cost_parts)
            .map(([key, value]) => `${key.replaceAll("_", " ")} ${withProvenance(formatCost(value), value)}`)
            .join(" · ")}
        </Text>
      )}
      {call.gap.value !== null && (
        <Text size="xs">
          Gap: {withProvenance(formatDuration(call.gap.value), call.gap)}
          {call.gap_basis ? ` (${call.gap_basis.replaceAll("_", " ")})` : ""}
        </Text>
      )}
    </div>
  );
}
