// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { MouseEvent, ReactNode } from "react";
import { type EntityRef, resolveEntity } from "../lib/entities";
import { truncateTitle } from "../lib/format";
import { type DetailTab, detailTab, writeInspection } from "../lib/inspectionLocation";
import classes from "./DetailLink.module.css";
import { useSessionInteraction } from "./SessionInteraction";

/** Caption navigation, independent of its containing row's marking action. */
export function DetailLink({
  label,
  entityRef = null,
  destinationTab,
  onOpen,
  onBeforeOpen,
  children,
}: {
  label: string;
  entityRef?: EntityRef | null;
  destinationTab?: DetailTab;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onBeforeOpen?: () => void;
  children: ReactNode;
}) {
  const fullCaption = typeof children === "string" ? children : null;
  const clippedCaption = fullCaption === null ? children : truncateTitle(fullCaption);
  const clippedLabel = truncateTitle(label);
  const interaction = useSessionInteraction();
  const entity =
    interaction === null || entityRef === null
      ? null
      : resolveEntity(interaction.root, interaction.sessionId, entityRef);
  const params =
    entity === null || entityRef === null
      ? null
      : writeInspection(new URLSearchParams(), {
          nodeId: entity.node.node_id,
          tab:
            destinationTab ??
            (entityRef.kind === "node"
              ? detailTab(entity.node.kind, null)
              : entityRef.kind === "transcript"
                ? "content"
                : "workflow"),
          selection: entityRef,
          invalidSelection: false,
        });
  const href =
    params === null || entityRef === null ? "#" : `/sessions/${encodeURIComponent(entityRef.sessionId)}?${params}`;
  return (
    <a
      href={href}
      className={classes.link}
      aria-label={`Show details: ${clippedLabel}`}
      title={fullCaption !== null && clippedCaption !== fullCaption ? fullCaption : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (href !== "#" && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
        event.preventDefault();
        onBeforeOpen?.();
        if (destinationTab !== undefined && entityRef !== null)
          interaction?.openEntity(entityRef, true, destinationTab);
        else if (onOpen) onOpen(event);
        else if (entityRef !== null) interaction?.openEntity(entityRef);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onBeforeOpen?.();
          if (destinationTab !== undefined && entityRef !== null)
            interaction?.openEntity(entityRef, true, destinationTab);
          else event.currentTarget.click();
        } else if (event.key === " ") {
          event.stopPropagation();
        }
      }}
    >
      {clippedCaption}
    </a>
  );
}
