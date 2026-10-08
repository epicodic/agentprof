// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Box, Group, Stack, Text, Title } from "@mantine/core";
import { type MouseEvent, useMemo } from "react";
import type { NodeOut } from "../api/types";
import { chartScale } from "../lib/chartScale";
import { type ContextBar, compactionMarks, contextBars, contextCalls, contextFigures } from "../lib/context";
import { callRefs, sameEntity } from "../lib/entities";
import { formatTokens } from "../lib/format";
import { nodeSpan, type Span } from "../lib/timeline";
import { ChartValueAxis } from "./ChartValueAxis";
import selectionClasses from "./EntitySelection.module.css";
import { type InspectionAction, useInspectionMenuTarget } from "./InspectionMenu";
import { TIMELINE_LABEL_WIDTH } from "./NodeTimeline";
import { useSessionInteraction } from "./SessionInteraction";

const COLORS = {
  cacheRead: "var(--mantine-color-teal-5)",
  cacheWrite: "var(--mantine-color-orange-5)",
  uncached: "var(--mantine-color-blue-6)",
};

function signed(tokens: number): string {
  return `${tokens < 0 ? "−" : "+"}${formatTokens(Math.abs(tokens))}`;
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <Group gap={4} wrap="nowrap">
      <Box w={10} h={10} style={{ background: color, borderRadius: 2 }} />
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Group>
  );
}

function ContextBarHit({
  bar,
  index,
  selected,
  label,
  onMark,
  onDetails,
}: {
  bar: ContextBar;
  index: number;
  selected: boolean;
  label: string;
  onMark: (event: MouseEvent<HTMLButtonElement>) => void;
  onDetails: () => void;
}) {
  const interaction = useSessionInteraction();
  const item = bar.item;
  const ref = interaction === null ? null : (callRefs(interaction.sessionId, item.owner)[item.index] ?? null);
  const menuTarget = useInspectionMenuTarget((): InspectionAction[] =>
    ref === null || interaction === null
      ? []
      : [
          { id: "details", label: `Show details: LLM call ${item.index + 1}`, run: onDetails },
          { id: "copy-link", label: "Copy link", run: () => interaction.copyLink(ref) },
        ],
  );
  return (
    <Box
      key={`bar-${item.start}-${index}`}
      data-testid={`context-bar-${item.owner.node_id}-${item.index}`}
      data-selection={interaction === null ? undefined : selected ? "exact" : "none"}
      className={interaction !== null && ref !== null ? selectionClasses.bar : undefined}
      pos="absolute"
      bottom={0}
      style={{ left: `${bar.left}%`, width: `calc(${bar.width}% + 1px)`, minWidth: 1, height: "100%" }}
    >
      <Box pos="absolute" bottom={0} w="100%" style={{ height: `${bar.cacheRead}%`, background: COLORS.cacheRead }} />
      <Box
        pos="absolute"
        w="100%"
        style={{ bottom: `${bar.cacheRead}%`, height: `${bar.cacheWrite}%`, background: COLORS.cacheWrite }}
      />
      <Box
        pos="absolute"
        w="100%"
        style={{
          bottom: `${bar.cacheRead + bar.cacheWrite}%`,
          height: `${bar.uncached}%`,
          background: COLORS.uncached,
        }}
      />
      {selected && <Box pos="absolute" inset={0} style={{ background: "rgba(40, 110, 220, 0.28)" }} />}
      {interaction !== null && (
        <Box
          component="button"
          type="button"
          aria-label={`Mark context for ${label}`}
          aria-pressed={selected}
          className={selectionClasses.bar}
          pos="absolute"
          inset={0}
          {...menuTarget}
          onClick={onMark}
          style={{ width: "100%", height: "100%", border: 0, padding: 0, background: "transparent" }}
        />
      )}
    </Box>
  );
}

/** Figures and a stacked bar chart of the node's own context sizes, on the same scale as the drawer timeline. */
export function ContextSection({
  node,
  view: sharedView,
  origin,
}: {
  node: NodeOut;
  view?: Span | null;
  origin?: number;
}) {
  const interaction = useSessionInteraction();
  const calls = useMemo(() => contextCalls(node), [node]);
  const refsByOwner = useMemo(() => {
    const result = new Map<string, ReturnType<typeof callRefs>>();
    if (interaction === null) return result;
    for (const item of calls) {
      if (!result.has(item.owner.node_id)) result.set(item.owner.node_id, callRefs(interaction.sessionId, item.owner));
    }
    return result;
  }, [calls, interaction]);
  const view = sharedView === undefined ? nodeSpan(node) : sharedView;
  const figures = contextFigures(node);
  if (node.kind === "tool" || view === null || figures === null) return null;

  const maximum = Math.max(0, ...calls.map((item) => item.size));
  const scale = chartScale(maximum, 1);
  const bars = contextBars(calls, view, scale.maximum || 1);
  const hasUnaddressableCall =
    interaction !== null && calls.some((item) => refsByOwner.get(item.owner.node_id)?.[item.index] == null);
  const parts = [
    `peak ${formatTokens(figures.peak)}`,
    `${figures.compactions} ${figures.compactions === 1 ? "compaction" : "compactions"}`,
    figures.growth === null ? null : `${signed(figures.growth)} per call`,
  ].filter((part) => part !== null);

  return (
    <Stack gap={4} data-testid="context-section">
      <Title order={5}>Context</Title>
      <Text size="sm">{parts.join(" · ")}</Text>
      <Text size="xs" c="dimmed">
        Click a bar to mark its call; use its context menu for details.
      </Text>
      {hasUnaddressableCall && (
        <Text size="xs" c="dimmed">
          Some calls have no stable selection identity.
        </Text>
      )}
      <ChartValueAxis
        unit="Tokens"
        scale={scale}
        format="tokens"
        view={view}
        origin={origin ?? view.start}
        chartTestId="context-chart"
      >
        {bars.map((bar, index) => {
          const ref = refsByOwner.get(bar.item.owner.node_id)?.[bar.item.index] ?? null;
          const selected = ref !== null && sameEntity(interaction?.location.selection ?? null, ref);
          const onMark = (event: MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            if (ref !== null) interaction?.selectEntity(ref);
            else interaction?.markLocal(`context:${bar.item.owner.node_id}`, `${bar.item.index}`);
          };
          const onDetails = () => {
            if (ref !== null) interaction?.openEntity(ref);
          };
          return (
            <ContextBarHit
              key={`${bar.item.owner.node_id}-${bar.item.index}`}
              bar={bar}
              index={index}
              selected={
                selected ||
                (interaction?.localMark?.viewKey === `context:${bar.item.owner.node_id}` &&
                  interaction.localMark.key === `${bar.item.index}`)
              }
              label={`LLM call ${bar.item.index + 1}`}
              onMark={onMark}
              onDetails={onDetails}
            />
          );
        })}
        {compactionMarks(node, view).map((mark) => (
          <Text
            key={mark.key}
            size="10px"
            c="red"
            pos="absolute"
            top={-2}
            style={{ left: `${mark.pct}%`, transform: "translateX(-50%)", zIndex: 3 }}
          >
            ▼
          </Text>
        ))}
      </ChartValueAxis>
      <Group gap="md" ml={TIMELINE_LABEL_WIDTH}>
        <Swatch color={COLORS.cacheRead} label="cache read" />
        <Swatch color={COLORS.cacheWrite} label="cache write" />
        <Swatch color={COLORS.uncached} label="uncached input" />
      </Group>
    </Stack>
  );
}
