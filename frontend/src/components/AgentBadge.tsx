// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { CSSProperties } from "react";
import { agentColor } from "../lib/agentColor";
import classes from "./AgentBadge.module.css";

export function AgentBadge({ agentId, active }: { agentId: number; active: boolean }) {
  const { hue } = agentColor(agentId);
  const className = active ? `${classes.capsule} ${classes.active}` : classes.capsule;

  return (
    <span className={className} style={{ "--agent-hue": hue } as CSSProperties}>
      {agentId}
    </span>
  );
}
