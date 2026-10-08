// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Badge, Tooltip } from "@mantine/core";

export function ActivityStatus({ activity }: { activity: "running" | "waiting" }) {
  const description =
    activity === "running"
      ? "This agent has unfinished work at the latest observed activity."
      : "This agent is waiting for an active sub-agent to finish.";
  return (
    <Tooltip label={description}>
      <Badge size="xs" color={activity === "running" ? "green" : "yellow"} variant="light" aria-label={description}>
        {activity.toUpperCase()}
      </Badge>
    </Tooltip>
  );
}
