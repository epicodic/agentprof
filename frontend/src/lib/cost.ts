// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { CostOut, LlmCallOut, NodeOut } from "../api/types";
import { compareSequenceEntries } from "./executionSequence";
import type { Span } from "./timeline";

export interface CostEvent {
  owner: NodeOut;
  index: number;
  call: LlmCallOut;
}

/** The main agent's calls live on turns; other nodes own their calls directly. */
export function costEvents(node: NodeOut): CostEvent[] {
  const owners = node.kind === "session" ? node.children.filter((child) => child.kind === "turn") : [node];
  return owners
    .flatMap((owner) => owner.llm_calls.map((call, index) => ({ owner, index, call })))
    .map((event, serial) => ({ event, serial }))
    .sort(
      (left, right) =>
        compareSequenceEntries(
          { kind: "call", call: left.event.call, originalIndex: left.event.index },
          { kind: "call", call: right.event.call, originalIndex: right.event.index },
        ) || left.serial - right.serial,
    )
    .map(({ event }) => event);
}

export function costMax(events: CostEvent[]): number {
  return Math.max(0, ...events.map((event) => event.call.cost.usd ?? 0));
}

/** Return only a positive span backed by both observed node timestamps. */
export function observedCostSpan(node: NodeOut): Span | null {
  const start = node.start.value;
  const end = node.end.value;
  return start !== null && end !== null && Number.isFinite(start) && Number.isFinite(end) && end > start
    ? { start, end }
    : null;
}

/** Use the observed node interval, then recorded call starts, only for chart positioning. */
export function costTimeDomain(events: readonly CostEvent[], view: Span | null): Span | null {
  if (view !== null && Number.isFinite(view.start) && Number.isFinite(view.end) && view.end > view.start) return view;
  const starts = events
    .map((event) => event.call.start.value)
    .filter((start): start is number => start !== null && Number.isFinite(start));
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const end = Math.max(...starts);
  if (end > start) return { start, end };
  const padding = 1000;
  return { start: start - padding, end: end + padding };
}

/** Sum visible own call costs in their native unit, retaining incomplete or estimated provenance. */
export function costSum(events: CostEvent[]): CostOut {
  const costs = events.map((event) => event.call.cost);
  const known = costs.filter((item): item is CostOut & { value: number } => item.value !== null);
  if (known.length === 0 || new Set(known.map((item) => item.unit)).size !== 1) {
    return { value: null, unit: null, usd: null, provenance: "n/a" };
  }
  const usdKnown = known.every((item) => item.usd !== null);
  return {
    value: known.reduce((sum, item) => sum + item.value, 0),
    unit: known[0]?.unit ?? null,
    usd: usdKnown ? known.reduce((sum, item) => sum + (item.usd ?? 0), 0) : null,
    provenance:
      known.length < costs.length || known.some((item) => item.provenance !== "exact") ? "estimated" : "exact",
  };
}

/** Percent on the time axis; unknown cost or start has no chart position. */
export function costPosition(event: CostEvent, view: Span): number | null {
  const start = event.call.start.value;
  if (start === null || event.call.cost.usd === null || view.end <= view.start) return null;
  const percent = ((start - view.start) / (view.end - view.start)) * 100;
  return percent >= 0 && percent <= 100 ? percent : null;
}
