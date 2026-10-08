// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { NodeOut } from "../api/types";
import { costEvents } from "./cost";
import type { Span } from "./timeline";

/** One plotting interval for the drawer's observed activity, cost and context. */
export function drawerTimeDomain(node: NodeOut): Span | null {
  const times: number[] = [];
  const include = (value: number | null) => {
    if (value !== null && Number.isFinite(value)) times.push(value);
  };
  include(node.start.value);
  include(node.end.value);
  for (const child of node.children) {
    include(child.start.value);
    include(child.end.value);
  }
  for (const { call } of costEvents(node)) {
    include(call.start.value);
    if (call.start.value !== null && call.duration.value !== null && call.duration.value >= 0) {
      include(call.start.value + call.duration.value);
    }
  }
  for (const mark of node.compactions) include(mark.value);
  if (times.length === 0) return null;
  const start = times.reduce((minimum, value) => Math.min(minimum, value), Infinity);
  const end = times.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
  return { start, end: end > start ? end : start + 1000 };
}
