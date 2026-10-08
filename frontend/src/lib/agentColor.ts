// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

const GOLDEN_ANGLE = 137.507764;

export interface AgentColor {
  hue: number;
}

/** A deterministic, evenly distributed color identity for an agent's display ID. */
export function agentColor(agentId: number): AgentColor {
  return { hue: ((agentId - 1) * GOLDEN_ANGLE) % 360 };
}
