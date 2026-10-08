// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Box } from "@mantine/core";
import { useElementSize, useMediaQuery } from "@mantine/hooks";
import { useMemo } from "react";
import type { NodeOut } from "../api/types";
import { costEvents } from "../lib/cost";
import { callRefs, sameEntity } from "../lib/entities";
import type { EntityChoice } from "../lib/entityHitGroups";
import { type EntityHitGroup, groupEntityHits, multiCandidateEntityKeys } from "../lib/entityHitGroups";
import { activityOf, bar, placeSegments, type Segment, type Span } from "../lib/timeline";
import { ActivityHitGroup, ActivitySingleHit } from "./ActivityHitGroup";
import selectionClasses from "./EntitySelection.module.css";
import { useSessionInteraction } from "./SessionInteraction";

const TRACK_HEIGHT = 14;
const TOP_LANE_HEIGHT = 8;
const BOTTOM_LANE_TOP = 10;
const BOTTOM_LANE_HEIGHT = 3;
const KIND_COLORS: Record<string, string> = { session: "gray", turn: "gray", agent: "violet", tool: "blue" };

function Block({
  left,
  width,
  top,
  height,
  color,
}: {
  left: number;
  width: number;
  top: number;
  height: number;
  color: string;
}) {
  return (
    <Box
      pos="absolute"
      style={{ left: `${left}%`, width: `${width}%`, top, height, borderRadius: 2, background: color }}
    />
  );
}

function failed(segment: Segment): boolean {
  return segment.nodes.some((node) => node.success === false);
}

function entityKey(ref: EntityChoice["ref"]): string {
  return ref.kind === "node"
    ? `node:${ref.nodeId}`
    : ref.kind === "call"
      ? `call:${ref.ownerId}:${ref.callKey}`
      : `event:${ref.ownerId}:${ref.eventId}`;
}

/** One node's activity on `view`: its span, own LLM calls on top, and tools and agents below. */
export function ActivityTrack({
  node,
  view,
  phoneHitTarget = false,
}: {
  node: NodeOut;
  view: Span | null;
  phoneHitTarget?: boolean;
}) {
  const interaction = useSessionInteraction();
  const { ref: trackRef, width: trackWidth } = useElementSize();
  const narrow = useMediaQuery("(max-width: 48em)");
  const phoneTreeTrack = narrow && phoneHitTarget;
  const hitHeight = narrow && phoneHitTarget ? 44 : TRACK_HEIGHT;
  const activity = useMemo(() => activityOf(node), [node]);
  const events = useMemo(() => costEvents(node), [node]);
  const refsByOwner = useMemo(() => {
    const result = new Map<string, ReturnType<typeof callRefs>>();
    if (interaction === null) return result;
    for (const item of events) {
      if (!result.has(item.owner.node_id)) result.set(item.owner.node_id, callRefs(interaction.sessionId, item.owner));
    }
    return result;
  }, [events, interaction]);
  if (view === null) return <Box />;

  const span = bar(node.start.value, node.end.value, view);
  const tools = placeSegments(activity.tools, view);
  const agents = placeSegments(activity.agents, view);
  const minimumHitWidth = phoneTreeTrack ? 44 : narrow ? 12 : 6;
  const minimumWidthPct = Math.min(100, (minimumHitWidth / Math.max(trackWidth, 1)) * 100);
  const boundaryInsetPct = Math.min(100, 300 / Math.max(trackWidth, 1));
  const maxHitLeftPct = Math.max(0, 100 - minimumWidthPct - boundaryInsetPct);
  const kindColor = node.success === false ? "red" : (KIND_COLORS[node.kind] ?? "gray");

  const hitGroups: EntityHitGroup[] = [];
  if (interaction !== null && view.end > view.start) {
    const hits: {
      left: number;
      width: number;
      ref: EntityChoice["ref"];
      label: string;
      testId: string;
      call: boolean;
      directLabel: string;
    }[] = [];
    const ownerTopicCounts = new Map<string, number>();
    for (const { owner } of events) {
      ownerTopicCounts.set(owner.topic, (ownerTopicCounts.get(owner.topic) ?? 0) + 1);
    }
    for (const { owner, index, call } of events) {
      const start = call.start.value;
      if (start === null) continue;
      const geometry = bar(start, call.duration.value === null ? start : start + call.duration.value, view);
      const ref = refsByOwner.get(owner.node_id)?.[index] ?? null;
      if (geometry === null || ref === null) continue;
      hits.push({
        left: Math.min(geometry.left, maxHitLeftPct),
        width: geometry.width,
        ref,
        label: `LLM call ${index + 1} · ${owner.topic}${(ownerTopicCounts.get(owner.topic) ?? 0) > 1 ? ` (${owner.node_id})` : ""}`,
        testId: `timeline-call-${owner.node_id}-${index}`,
        call: true,
        directLabel: `timeline LLM call ${index + 1}`,
      });
    }
    for (const { segment } of [...tools, ...agents]) {
      for (const child of segment.nodes) {
        const geometry = bar(child.start.value, child.end.value, view);
        if (geometry === null) continue;
        const ref = { kind: "node" as const, sessionId: interaction.sessionId, nodeId: child.node_id };
        hits.push({
          left: Math.min(geometry.left, maxHitLeftPct),
          width: geometry.width,
          ref,
          label:
            child.kind === "tool" ? `tool ${child.tool?.native_id ?? "tool"}: ${child.topic}` : `agent: ${child.topic}`,
          testId: `activity-node-${child.node_id}`,
          call: false,
          directLabel:
            child.kind === "tool" ? `tool ${child.tool?.native_id ?? "tool"}: ${child.topic}` : `agent: ${child.topic}`,
        });
      }
    }
    hitGroups.push(...groupEntityHits(hits, minimumWidthPct));
  }
  const groupedEntityKeys = multiCandidateEntityKeys(hitGroups);

  const hitMetadata = new Map<string, { testId: string; call: boolean; directLabel: string }>();
  if (interaction !== null) {
    for (const { owner, index, call } of events) {
      if (call.start.value === null) continue;
      const ref = refsByOwner.get(owner.node_id)?.[index] ?? null;
      if (ref !== null) {
        hitMetadata.set(entityKey(ref), {
          testId: `timeline-call-${owner.node_id}-${index}`,
          call: true,
          directLabel: `timeline LLM call ${index + 1}`,
        });
      }
    }
    for (const segment of [...activity.tools, ...activity.agents]) {
      for (const child of segment.nodes) {
        const ref = { kind: "node" as const, sessionId: interaction.sessionId, nodeId: child.node_id };
        hitMetadata.set(entityKey(ref), {
          testId: `activity-node-${child.node_id}`,
          call: false,
          directLabel:
            child.kind === "tool" ? `tool ${child.tool?.native_id ?? "tool"}: ${child.topic}` : `agent: ${child.topic}`,
        });
      }
    }
  }

  return (
    <Box
      ref={trackRef}
      data-testid={`track-${node.node_id}`}
      pos="relative"
      w={phoneTreeTrack ? "100%" : undefined}
      h={narrow && phoneHitTarget ? 44 : TRACK_HEIGHT}
      mx={4}
      style={{ overflow: "visible" }}
    >
      {span !== null && (
        <Block {...span} top={0} height={TRACK_HEIGHT} color={`var(--mantine-color-${kindColor}-light)`} />
      )}
      {events.flatMap(({ owner, index, call }) => {
        const start = call.start.value;
        const duration = call.duration.value;
        if (start === null || duration === null) return [];
        const geometry = bar(start, start + duration, view);
        return geometry === null
          ? []
          : [
              <Block
                key={`llm-${owner.node_id}-${index}`}
                {...geometry}
                top={0}
                height={TOP_LANE_HEIGHT}
                color="var(--mantine-color-gray-5)"
              />,
            ];
      })}
      {events.flatMap(({ owner, index, call }) => {
        const start = call.start.value;
        if (start === null || call.duration.value !== null || start < view.start || start > view.end) return [];
        const pct = ((start - view.start) / (view.end - view.start)) * 100;
        return [
          <Box
            key={`llm-tick-${owner.node_id}-${index}`}
            data-testid={`timeline-call-tick-${owner.node_id}-${index}`}
            pos="absolute"
            top={0}
            h={TOP_LANE_HEIGHT}
            w={1}
            style={{ left: `${pct}%`, background: "var(--mantine-color-dimmed)" }}
          />,
        ];
      })}
      {node.kind === "agent" &&
        node.resume_times.map((resume, index) => {
          const time = resume.value;
          if (time === null || time < view.start || time > view.end) return null;
          const pct = ((time - view.start) / (view.end - view.start)) * 100;
          return (
            <Box
              // biome-ignore lint/suspicious/noArrayIndexKey: resume times may be identical
              key={index}
              data-testid={`resume-mark-${node.node_id}-${index}`}
              title="Agent resumed"
              pos="absolute"
              top={0}
              h={TRACK_HEIGHT}
              w={2}
              style={{ left: `${pct}%`, background: "var(--mantine-color-orange-filled)" }}
            />
          );
        })}
      {tools.map(({ segment, left, width }) => (
        <Block
          key={`tool-${segment.nodes[0].node_id}`}
          left={left}
          width={width}
          top={0}
          height={TOP_LANE_HEIGHT}
          color={failed(segment) ? "var(--mantine-color-red-filled)" : "var(--mantine-color-blue-filled)"}
        />
      ))}
      {agents.map(({ segment, left, width }) => (
        <Block
          key={`agent-${segment.nodes[0].node_id}`}
          left={left}
          width={width}
          top={BOTTOM_LANE_TOP}
          height={BOTTOM_LANE_HEIGHT}
          color="var(--mantine-color-violet-filled)"
        />
      ))}
      {interaction !== null &&
        events.map(({ owner, index, call }) => {
          const start = call.start.value;
          const duration = call.duration.value;
          const geometry = bar(start, start === null ? null : duration === null ? start : start + duration, view);
          const ref = refsByOwner.get(owner.node_id)?.[index] ?? null;
          if (geometry === null || ref === null) return null;
          const selected = sameEntity(interaction.location.selection, ref);
          const individualHit = groupedEntityKeys.has(entityKey(ref));
          return (
            <Box
              component="span"
              key={`timeline-call-${owner.node_id}-${index}`}
              data-testid={individualHit ? `timeline-call-${owner.node_id}-${index}` : undefined}
              data-selection={selected ? "exact" : "none"}
              className={selectionClasses.timelinePaint}
              pos="absolute"
              top={0}
              style={{
                left: `${Math.min(geometry.left, maxHitLeftPct)}%`,
                width: `${Math.min(geometry.width, 100 - Math.min(geometry.left, maxHitLeftPct))}%`,
                height: TOP_LANE_HEIGHT,
                zIndex: 1,
                pointerEvents: "none",
                background: "transparent",
              }}
            />
          );
        })}
      {interaction !== null &&
        hitGroups.map((group) => {
          const candidates = group.candidates;
          const groupHits = candidates.flatMap((candidate) => {
            const metadata = hitMetadata.get(entityKey(candidate.ref));
            return metadata === undefined ? [] : [{ candidate, metadata }];
          });
          if (groupHits.length === 0) return null;
          const left = Math.min(group.left, 100 - minimumWidthPct);
          const singleton = groupHits.length === 1 ? groupHits[0] : null;
          if (singleton !== null) {
            const { candidate, metadata } = singleton;
            return (
              <ActivitySingleHit
                key={entityKey(candidate.ref)}
                refEntity={candidate.ref}
                label={metadata.directLabel}
                testId={metadata.testId}
                left={left}
                width={Math.min(group.width, 100 - left)}
                height={hitHeight}
              />
            );
          }
          const chooserLabel = `overlapping activity: ${groupHits.map(({ candidate }) => candidate.label).join("; ")}`;
          return (
            <Box
              key={`hit-group-${group.candidates.map((candidate) => entityKey(candidate.ref)).join("|")}`}
              pos="absolute"
              top={0}
              style={{
                left: `${left}%`,
                width: `${Math.min(group.width, 100 - left)}%`,
                height: hitHeight,
                zIndex: 4,
              }}
              aria-label={chooserLabel}
              data-hit-testids={groupHits.map(({ metadata }) => metadata.testId).join(" ")}
              data-testid={`activity-hit-group-${group.candidates.map((candidate) => entityKey(candidate.ref)).join("|")}`}
            >
              <ActivityHitGroup
                nodeId={node.node_id}
                label={chooserLabel}
                candidates={groupHits.map(({ candidate }) => candidate)}
              />
            </Box>
          );
        })}
      {interaction !== null &&
        events.map(({ owner, index, call }) => {
          if ((refsByOwner.get(owner.node_id)?.[index] ?? null) !== null || call.start.value === null) return null;
          const geometry = bar(
            call.start.value,
            call.duration.value === null ? call.start.value : call.start.value + call.duration.value,
            view,
          );
          if (geometry === null) return null;
          const left = Math.min(geometry.left, maxHitLeftPct);
          return (
            <ActivitySingleHit
              key={`local-call-${owner.node_id}-${index}`}
              refEntity={null}
              localMark={{ viewKey: `call:${owner.node_id}`, key: `call-index:${index}` }}
              label={`LLM call ${index + 1} · ${owner.topic}`}
              testId={`timeline-call-${owner.node_id}-${index}`}
              left={left}
              width={Math.min(geometry.width, 100 - left)}
              height={hitHeight}
            />
          );
        })}
    </Box>
  );
}
