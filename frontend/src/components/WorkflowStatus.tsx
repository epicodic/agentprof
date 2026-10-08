// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Badge, Tooltip } from "@mantine/core";
import type { WorkflowObservation } from "../lib/workflowState";

export function WorkflowStatus({ observation }: { observation: WorkflowObservation }) {
  if (observation.status === "unknown") return null;

  const status = observation.status;
  const label = status.toUpperCase();
  const description =
    status === "running"
      ? "Running · inferred from the latest observed activity. This agent has unfinished work."
      : status === "waiting"
        ? "Waiting · inferred from the latest observed activity. This agent is waiting for an active sub-agent."
        : status === "completed"
          ? "Own completion recorded in this session."
          : "Own failure recorded in this session.";
  const completionNote =
    observation.completionRecorded && status !== "completed" && status !== "failed"
      ? observation.latest === null
        ? "Completion was also recorded; latest ordering is unavailable."
        : "An earlier completion was also recorded."
      : null;
  const tooltip = completionNote === null ? description : `${description} ${completionNote}`;
  const color = status === "running" ? "green" : status === "waiting" ? "yellow" : status === "failed" ? "red" : "gray";

  return (
    <Tooltip label={tooltip}>
      <Badge
        component="span"
        size="xs"
        color={color}
        variant="light"
        aria-label={tooltip}
        data-workflow-status={status}
      >
        {label}
      </Badge>
    </Tooltip>
  );
}
