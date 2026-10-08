// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Box, Group, Stack, Text, Title } from "@mantine/core";
import { Fragment, useMemo } from "react";
import type { NodeOut } from "../api/types";
import { type EntityRef, relationsToNodes } from "../lib/entities";
import { nodeSpan, type Span } from "../lib/timeline";
import { findNode, navigationParentId, subAgents, turns } from "../lib/tree";
import { ActivityTrack } from "./ActivityTrack";
import { AxisLabels } from "./AxisLabels";
import { DetailLink } from "./DetailLink";
import selectionClasses from "./EntitySelection.module.css";
import { type InspectionAction, useInspectionMenuTarget } from "./InspectionMenu";
import { useSessionInteraction } from "./SessionInteraction";

/** Width of the label column; the context chart (plan 7) reuses it so both share one horizontal scale. */
export const TIMELINE_LABEL_WIDTH = 180;

const CHILD_MARKS: Record<string, string> = { turn: "▣", agent: "◆" };

/** The node's own track and one track per direct child (turns of a session, else sub-agents), all on the node's span. */
export function NodeTimeline({
  node,
  onSelect,
  view: sharedView,
  origin,
}: {
  node: NodeOut;
  onSelect: (nodeId: string) => void;
  view?: Span | null;
  origin?: number;
}) {
  const interaction = useSessionInteraction();
  const selectionRoot = interaction?.root ?? null;
  const selectionRef = interaction?.location.selection ?? null;
  const resolvedSelection = interaction?.resolved ?? null;
  const selectionRelations = useMemo(
    () => (selectionRoot === null ? new Map() : relationsToNodes(selectionRoot, selectionRef, resolvedSelection)),
    [selectionRoot, selectionRef, resolvedSelection],
  );
  const menuTarget = useInspectionMenuTarget((target) => {
    if (interaction === null) return [];
    const child = findNode(interaction.root, target.dataset.nodeId ?? "");
    if (child === null) return [];
    const ref: EntityRef = { kind: "node", sessionId: interaction.sessionId, nodeId: child.node_id };
    const actions: InspectionAction[] = [
      { id: "details", label: "Show details", run: () => interaction.openEntity(ref) },
    ];
    const parentId = navigationParentId(interaction.root, child.node_id);
    if (parentId !== null)
      actions.push({ id: "parent", label: "Show parent agent", run: () => interaction.openNode(parentId) });
    actions.push({ id: "copy", label: "Copy link", run: () => interaction.copyLink(ref) });
    return actions;
  });
  const view = sharedView === undefined ? nodeSpan(node) : sharedView;
  if (node.kind === "tool" || view === null) return null;
  const children = (node.kind === "session" ? turns(node) : subAgents(node)).map(({ node: child }) => child);
  return (
    <Stack gap={4} data-testid="node-timeline">
      <Title order={5}>Timeline</Title>
      <Box
        style={{
          display: "grid",
          gridTemplateColumns: `${TIMELINE_LABEL_WIDTH}px 1fr`,
          rowGap: 6,
          alignItems: "center",
        }}
      >
        <Box />
        <Box px={4}>
          <AxisLabels view={view} origin={origin ?? view.start} />
        </Box>
        <Text size="xs" c="dimmed">
          this node
        </Text>
        <ActivityTrack node={node} view={view} />
        {children.map((child) => {
          const ref: EntityRef | null =
            interaction === null ? null : { kind: "node", sessionId: interaction.sessionId, nodeId: child.node_id };
          const activate = () => {
            if (ref !== null) interaction?.selectEntity(ref);
          };
          const selection = selectionRelations.get(child.node_id) ?? "none";
          return (
            <Fragment key={child.node_id}>
              <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
                <Text
                  size="xs"
                  truncate="end"
                  title={child.topic}
                  data-node-id={child.node_id}
                  onContextMenu={menuTarget.onContextMenu}
                  onPointerDown={menuTarget.onPointerDown}
                  onPointerMove={menuTarget.onPointerMove}
                  onPointerUp={menuTarget.onPointerUp}
                  onPointerCancel={menuTarget.onPointerCancel}
                  onClickCapture={menuTarget.onClickCapture}
                  onKeyDown={(event) => {
                    menuTarget.onKeyDown(event);
                  }}
                >
                  {CHILD_MARKS[child.kind]}{" "}
                  <DetailLink
                    label={child.topic}
                    entityRef={ref}
                    onOpen={() => {
                      if (ref !== null) interaction?.openEntity(ref);
                      else onSelect(child.node_id);
                    }}
                  >
                    {child.topic}
                  </DetailLink>
                </Text>
              </Group>
              <Box
                data-testid={`timeline-row-${child.node_id}`}
                data-node-id={child.node_id}
                data-selection={selection}
                className={selectionClasses.item}
                onClick={activate}
                onContextMenu={menuTarget.onContextMenu}
                onKeyDown={(event) => menuTarget.onKeyDown(event)}
                onPointerDown={menuTarget.onPointerDown}
                onPointerMove={menuTarget.onPointerMove}
                onPointerUp={menuTarget.onPointerUp}
                onPointerCancel={menuTarget.onPointerCancel}
                onClickCapture={menuTarget.onClickCapture}
                style={{ cursor: "default" }}
              >
                <ActivityTrack node={child} view={view} />
              </Box>
            </Fragment>
          );
        })}
      </Box>
    </Stack>
  );
}
