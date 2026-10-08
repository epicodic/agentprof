// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { LlmCallOut, NodeOut } from "../api/types";
import { costEvents } from "./cost";
import type { Span } from "./timeline";

/** One own LLM call with its context size split into its parts. */
export interface ContextCall {
  owner: NodeOut;
  index: number;
  call: LlmCallOut;
  start: number;
  size: number;
  cacheRead: number;
  cacheWrite: number;
  uncached: number;
}

export interface ContextFigures {
  peak: number;
  compactions: number;
  /** Mean change of the context size between consecutive calls, leaving out steps across a compaction. */
  growth: number | null;
}

/** A stacked bar in percent: `left`/`width` of the view, the three heights of the scale. */
export interface ContextBar {
  item: ContextCall;
  left: number;
  width: number;
  cacheRead: number;
  cacheWrite: number;
  uncached: number;
}

function position(time: number, view: Span): number {
  return ((time - view.start) / (view.end - view.start)) * 100;
}

/** The node's own calls in its context with a start and at least one known input part, sorted by start. */
export function contextCalls(node: NodeOut): ContextCall[] {
  return costEvents(node)
    .flatMap((call) => {
      const { input, cache_read, cache_write } = call.call.tokens;
      const start = call.call.start.value;
      const unknown = input.value === null && cache_read.value === null && cache_write.value === null;
      if (!call.call.in_context || start === null || unknown) {
        return [];
      }
      const uncached = input.value ?? 0;
      const cacheRead = cache_read.value ?? 0;
      const cacheWrite = cache_write.value ?? 0;
      return [{ ...call, start, size: uncached + cacheRead + cacheWrite, cacheRead, cacheWrite, uncached }];
    })
    .sort((a, b) => a.start - b.start);
}

export function contextFigures(node: NodeOut): ContextFigures | null {
  const calls = contextCalls(node);
  if (calls.length === 0) return null;
  const peak = node.context_peak.value ?? Math.max(...calls.map((item) => item.size));
  const compactionTimes = node.compactions.flatMap((mark) => (mark.value === null ? [] : [mark.value]));
  const steps: number[] = [];
  for (let index = 1; index < calls.length; index += 1) {
    const before = calls[index - 1];
    const after = calls[index];
    if (before === undefined || after === undefined) continue;
    if (compactionTimes.some((time) => time > before.start && time <= after.start)) continue;
    steps.push(after.size - before.size);
  }
  return {
    peak,
    compactions: node.compactions.length,
    growth: steps.length === 0 ? null : steps.reduce((sum, step) => sum + step, 0) / steps.length,
  };
}

/** The latest call at or before `time`, whose context applies at that moment. */
export function contextAt(calls: ContextCall[], time: number): ContextCall | null {
  let found: ContextCall | null = null;
  for (const item of calls) {
    if (item.start > time) break;
    found = item;
  }
  return found;
}

/** The chart's full height in tokens: the largest call, at least 1. */
export function contextScale(calls: ContextCall[]): number {
  return Math.max(1, ...calls.map((item) => item.size));
}

/** One stacked bar per call in the view; a call's context holds until the next call, the last one until the view's end. */
export function contextBars(calls: ContextCall[], view: Span, scale: number): ContextBar[] {
  const lefts = calls.map((item) => position(item.start, view));
  return calls.flatMap((item, index) => {
    const left = lefts[index];
    if (left === undefined || left < 0 || left > 100) return [];
    const right = Math.min(100, lefts[index + 1] ?? 100);
    return [
      {
        item,
        left,
        width: Math.max(0, right - left),
        cacheRead: (item.cacheRead / scale) * 100,
        cacheWrite: (item.cacheWrite / scale) * 100,
        uncached: (item.uncached / scale) * 100,
      },
    ];
  });
}

/** Positions of the node's compactions inside the view. */
export function compactionMarks(node: NodeOut, view: Span): { key: string; pct: number }[] {
  return node.compactions.flatMap((mark, index) => {
    if (mark.value === null || mark.value < view.start || mark.value > view.end) return [];
    return [{ key: `compaction-${index}`, pct: position(mark.value, view) }];
  });
}
