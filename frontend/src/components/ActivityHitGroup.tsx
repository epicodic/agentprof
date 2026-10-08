// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Box } from "@mantine/core";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { EntityRef } from "../lib/entities";
import { sameEntity } from "../lib/entities";
import type { EntityChoice } from "../lib/entityHitGroups";
import selectionClasses from "./EntitySelection.module.css";
import { useInspectionMenuTarget } from "./InspectionMenu";
import { useSessionInteraction } from "./SessionInteraction";

export function ActivityHitGroup({
  nodeId,
  candidates,
  label,
}: {
  nodeId: string;
  candidates: readonly EntityChoice[];
  label: string;
}) {
  const interaction = useSessionInteraction();
  const key = candidates.map(({ ref }) => entityKey(ref)).join("|");
  const selected = interaction?.localMark?.viewKey === `activity-group:${nodeId}` && interaction.localMark.key === key;
  const actions = () =>
    candidates.map((candidate) => ({
      id: entityKey(candidate.ref),
      label: `Show details: ${candidate.label}`,
      run: () => interaction?.openEntity(candidate.ref),
    }));
  const menuTarget = useInspectionMenuTarget(actions);
  const mark = () => interaction?.markLocal(`activity-group:${nodeId}`, key);
  return (
    <fieldset
      tabIndex={-1}
      aria-label={label}
      data-selection={selected ? "exact" : "none"}
      data-testid={`activity-hit-group-${nodeId}-${key}`}
      className={selectionClasses.item}
      {...menuTarget}
      onContextMenu={(event) => {
        event.stopPropagation();
        menuTarget.onContextMenu(event);
      }}
      onKeyDown={(event) => {
        menuTarget.onKeyDown(event);
        if (event.defaultPrevented) event.stopPropagation();
      }}
      style={{ all: "unset", display: "block", width: "100%", height: "100%", position: "relative" }}
    >
      <button
        type="button"
        aria-label={`Mark ${label}`}
        aria-pressed={selected}
        className={selectionClasses.item}
        onClick={(event) => {
          event.stopPropagation();
          mark();
        }}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          padding: 0,
          border: 0,
          background: "transparent",
        }}
      />
    </fieldset>
  );
}

export function ActivitySingleHit({
  refEntity,
  localMark,
  label,
  testId,
  left,
  width,
  height,
}: {
  refEntity: EntityRef | null;
  localMark?: { viewKey: string; key: string };
  label: string;
  testId: string;
  left: number;
  width: number;
  height: number;
}) {
  const interaction = useSessionInteraction();
  const selected =
    refEntity !== null
      ? sameEntity(interaction?.location.selection ?? null, refEntity)
      : localMark !== undefined &&
        interaction?.localMark?.viewKey === localMark.viewKey &&
        interaction.localMark.key === localMark.key;
  const menuTarget = useInspectionMenuTarget(() =>
    interaction === null || refEntity === null
      ? []
      : [
          { id: "details", label: `Show details: ${label}`, run: () => interaction.openEntity(refEntity) },
          { id: "copy-link", label: "Copy link", run: () => interaction.copyLink(refEntity) },
        ],
  );
  const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (refEntity !== null) interaction?.selectEntity(refEntity);
    else if (localMark !== undefined) interaction?.markLocal(localMark.viewKey, localMark.key);
  };
  return (
    <Box
      component="button"
      type="button"
      aria-label={`Select ${label}`}
      aria-pressed={selected}
      data-testid={testId}
      data-selection={selected ? "exact" : "none"}
      className={`${selectionClasses.bar} ${selectionClasses.timelineCall}`}
      pos="absolute"
      top={0}
      {...menuTarget}
      onClick={onClick}
      style={{
        left: `${left}%`,
        width: `${width}%`,
        height,
        zIndex: 3,
        padding: 0,
        border: 0,
        background: selected ? "rgba(40, 110, 220, 0.28)" : "transparent",
      }}
    />
  );
}

function entityKey(ref: EntityRef): string {
  return ref.kind === "node"
    ? `node:${ref.nodeId}`
    : ref.kind === "call"
      ? `call:${ref.ownerId}:${ref.callKey}`
      : `event:${ref.ownerId}:${ref.eventId}`;
}
