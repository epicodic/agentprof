// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Box, Group, Stack, Text, Title } from "@mantine/core";
import { useMemo } from "react";
import type { NodeOut } from "../api/types";
import { chartBarHeight, chartScale } from "../lib/chartScale";
import {
  type CostEvent,
  costEvents,
  costMax,
  costPosition,
  costSum,
  costTimeDomain,
  observedCostSpan,
} from "../lib/cost";
import type { EntityRef } from "../lib/entities";
import { callRefs, sameEntity } from "../lib/entities";
import { formatCost, formatTimestamp, truncateTitle, withProvenance } from "../lib/format";
import type { Span } from "../lib/timeline";
import { CHART_HEIGHT, ChartValueAxis } from "./ChartValueAxis";
import selectionClasses from "./EntitySelection.module.css";
import { type InspectionAction, useInspectionMenuTarget } from "./InspectionMenu";
import { TIMELINE_LABEL_WIDTH } from "./NodeTimeline";
import { useSessionInteraction } from "./SessionInteraction";

interface Props {
  view?: Span | null;
  origin?: number;
  node: NodeOut;
  onFocus: (event: CostEvent) => void;
}

interface CostBarProps {
  event: CostEvent;
  refEntity: EntityRef | null;
  position: number;
  height: number;
  zeroCost: boolean;
  selected: boolean;
  onMark: () => void;
  onDetails: () => void;
}

function CostBar({ event, refEntity, position, height, zeroCost, selected, onMark, onDetails }: CostBarProps) {
  const interaction = useSessionInteraction();
  const menuTarget = useInspectionMenuTarget((): InspectionAction[] =>
    refEntity === null || interaction === null
      ? []
      : [
          {
            id: "details",
            label: `Show details: ${event.owner.topic} · LLM call ${event.index + 1}`,
            run: onDetails,
          },
          { id: "copy-link", label: "Copy link", run: () => interaction.copyLink(refEntity) },
        ],
  );
  const label = `${truncateTitle(event.owner.topic)}: ${formatCost(event.call.cost)}; elapsed time ${formatTimestamp(event.call.start.value)}`;
  return (
    <Box
      component="button"
      type="button"
      aria-label={label}
      aria-pressed={interaction !== null ? selected : undefined}
      data-testid={`cost-bar-${event.owner.node_id}-${event.index}`}
      data-selection={interaction === null ? undefined : selected ? "exact" : "none"}
      className={selectionClasses.bar}
      onClick={onMark}
      {...menuTarget}
      pos="absolute"
      bottom={0}
      style={{
        left: zeroCost ? `calc(${position}% - 6px)` : `${position}%`,
        width: zeroCost ? 16 : 4,
        height: zeroCost ? 16 : height,
        border: 0,
        padding: 0,
        background: selected
          ? "var(--mantine-color-blue-light)"
          : zeroCost
            ? "transparent"
            : "var(--mantine-color-orange-6)",
        cursor: "default",
      }}
    >
      {zeroCost && (
        <span aria-hidden="true" style={{ position: "absolute", left: 6, bottom: 0, width: 4, height: 0 }} />
      )}
    </Box>
  );
}

/** Each vertical bar is one model request, positioned at its recorded elapsed time. */
export function CostSection({ node, onFocus, view: sharedView, origin }: Props) {
  const interaction = useSessionInteraction();
  const sessionId = interaction?.sessionId ?? null;
  const events = useMemo(() => costEvents(node), [node]);
  const refsByOwner = useMemo(() => {
    if (sessionId === null) return new Map<string, ReturnType<typeof callRefs>>();
    const result = new Map<string, ReturnType<typeof callRefs>>();
    for (const event of events) {
      if (!result.has(event.owner.node_id)) result.set(event.owner.node_id, callRefs(sessionId, event.owner));
    }
    return result;
  }, [sessionId, events]);
  const view = sharedView === undefined ? costTimeDomain(events, observedCostSpan(node)) : sharedView;
  if (node.kind === "tool" || events.length === 0) return null;
  const max = costMax(events);
  const scale = chartScale(max);
  const ownCost = costSum(events);
  const hasUnknownCost = events.some((event) => event.call.cost.usd === null);
  const hasUntimedKnownCost = events.some((event) => event.call.cost.usd !== null && event.call.start.value === null);
  const hasUsageReportTime = events.some((event) => event.call.timing_basis === "usage_report");
  const hasTurnStartFallback = events.some((event) => event.call.timing_basis === "turn_start");
  const selectedRef = interaction?.location.selection ?? null;

  return (
    <Stack gap={4} data-testid="cost-section">
      <Title order={5}>Cost per LLM call</Title>
      <Text size="sm">
        Own LLM cost {withProvenance(formatCost(ownCost), ownCost)} · {events.length} calls
      </Text>
      <Text size="xs" c="dimmed">
        Click a bar to mark its call; use its context menu for details.
      </Text>
      {hasUnknownCost && (
        <Text size="xs" c="dimmed">
          Calls with unknown cost remain in the table and have no cost bar.
        </Text>
      )}
      {hasUntimedKnownCost && (
        <Text size="xs" c="dimmed">
          Untimed calls remain in the table and are unavailable on the elapsed axis.
        </Text>
      )}
      {view === null ? (
        <Text size="xs" c="dimmed" role="status">
          Elapsed-time positioning unavailable; calls remain in the table.
        </Text>
      ) : (
        <>
          {(hasUsageReportTime || hasTurnStartFallback) && (
            <Text size="xs" c="dimmed">
              Elapsed positions use recorded timestamps; usage-report times may follow request start, and turn-start
              times are fallbacks.
            </Text>
          )}
          <ChartValueAxis
            unit="USD per call"
            scale={scale}
            format="usd"
            view={view}
            origin={origin ?? view.start}
            chartTestId="cost-chart"
          >
            {events.map((event) => {
              const costUsd = event.call.cost.usd;
              const position = costPosition(event, view);
              if (position === null || costUsd === null) return null;
              const zeroCost = costUsd === 0;
              const height = chartBarHeight(costUsd, scale.maximum, CHART_HEIGHT);
              const refEntity = refsByOwner.get(event.owner.node_id)?.[event.index] ?? null;
              const localKey = `call-index:${event.index}`;
              const localSelected =
                interaction?.localMark?.viewKey === `call:${event.owner.node_id}` &&
                interaction.localMark.key === localKey;
              const selected = (refEntity !== null && sameEntity(selectedRef, refEntity)) || localSelected;
              const onMark = () => {
                if (interaction !== null) {
                  if (refEntity !== null) interaction.selectEntity(refEntity);
                  else interaction.markLocal(`call:${event.owner.node_id}`, localKey);
                } else {
                  onFocus(event);
                }
              };
              const onDetails = () => {
                if (refEntity !== null) interaction?.openEntity(refEntity);
              };
              return (
                <Box key={`${event.owner.node_id}-${event.index}`}>
                  <CostBar
                    event={event}
                    refEntity={refEntity}
                    position={position}
                    height={height}
                    zeroCost={zeroCost}
                    selected={selected}
                    onMark={onMark}
                    onDetails={onDetails}
                  />
                </Box>
              );
            })}
          </ChartValueAxis>
        </>
      )}
      <Group gap="xs" ml={TIMELINE_LABEL_WIDTH}>
        <Box w={10} h={10} style={{ background: "var(--mantine-color-orange-6)" }} />
        <Text size="xs" c="dimmed">
          Estimated request cost where available; tool calls have no separate recorded cost.
        </Text>
      </Group>
    </Stack>
  );
}
