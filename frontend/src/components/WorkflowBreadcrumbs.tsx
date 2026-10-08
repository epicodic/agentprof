// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { NodeOut } from "../api/types";
import { DetailLink } from "./DetailLink";
import classes from "./WorkflowToolbar.module.css";

export function WorkflowBreadcrumbs({
  ancestors,
  label,
  sessionId,
  onInspect,
}: {
  ancestors: readonly NodeOut[];
  label: "Workflow ancestry" | "Inspected ancestry";
  sessionId: string;
  onInspect: (nodeId: string) => void;
}) {
  return (
    <nav aria-label={label} className={classes.ancestry}>
      <ol>
        {ancestors.map((node) => (
          <li key={node.node_id} data-node-id={node.node_id}>
            <DetailLink
              label={node.topic}
              entityRef={{ kind: "node", sessionId, nodeId: node.node_id }}
              onOpen={() => onInspect(node.node_id)}
            >
              {node.topic}
            </DetailLink>
          </li>
        ))}
      </ol>
    </nav>
  );
}
