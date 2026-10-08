// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { LlmCallOut, NodeOut } from "../api/types";
import { formatDuration } from "./format";

export interface Span {
  start: number;
  end: number;
}

const MIN_BAR_WIDTH_PCT = 0.4;

export function nodeSpan(node: NodeOut): Span | null {
  const start = node.start.value;
  const end = node.end.value;
  if (start === null) return null;
  return end === null || end <= start ? { start, end: start + 1 } : { start, end };
}

/** The part of `span` between two percentages. */
export function zoom(span: Span, fromPct: number, toPct: number): Span {
  const width = span.end - span.start;
  return { start: span.start + (width * fromPct) / 100, end: span.start + (width * toPct) / 100 };
}

function position(time: number, view: Span): number {
  return ((time - view.start) / (view.end - view.start)) * 100;
}

/** Left offset and width in percent of the view, or `null` if the span is unknown or outside the view. */
export function bar(startMs: number | null, endMs: number | null, view: Span): { left: number; width: number } | null {
  if (startMs === null) return null;
  const endValue = endMs ?? startMs;
  if (endValue < view.start || startMs > view.end) return null;
  const left = Math.max(0, position(startMs, view));
  const right = Math.min(100, position(endValue, view));
  return { left, width: Math.max(MIN_BAR_WIDTH_PCT, right - left) };
}

export function ticks(calls: LlmCallOut[], view: Span): { key: string; pct: number }[] {
  return calls.flatMap((call, index) => {
    const start = call.start.value;
    return start !== null && start >= view.start && start <= view.end
      ? [{ key: `call-${index}`, pct: position(start, view) }]
      : [];
  });
}

/** `intervals + 1` evenly spaced labels, as time since `origin`. */
export function axisLabels(view: Span, origin: number, intervals = 4): { pct: number; label: string }[] {
  return Array.from({ length: intervals + 1 }, (_, index) => {
    const pct = (index * 100) / intervals;
    return { pct, label: formatDuration(view.start + ((view.end - view.start) * pct) / 100 - origin) };
  });
}

/** A time span on a track and the nodes drawn in it. */
export interface Segment {
  start: number;
  end: number;
  nodes: NodeOut[];
}

/** What a node's timeline track draws. */
export interface Activity {
  /** Own LLM calls with a known duration. */
  llm: Span[];
  /** Own LLM calls with a start but no known duration, drawn as ticks. */
  llmTicks: LlmCallOut[];
  /** Direct tool calls, overlapping ones merged. */
  tools: Segment[];
  /** Direct sub-agents, overlapping ones merged. */
  agents: Segment[];
}

export interface PlacedSegment {
  segment: Segment;
  left: number;
  width: number;
}

/** Nodes as time-ordered segments; nodes whose spans overlap share a segment; nodes without a start are left out. */
export function mergeSegments(nodes: NodeOut[]): Segment[] {
  const timed = nodes
    .flatMap((node) => {
      const start = node.start.value;
      return start === null ? [] : [{ start, end: Math.max(start, node.end.value ?? start), node }];
    })
    .sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  for (const item of timed) {
    const last = segments.at(-1);
    if (last !== undefined && item.start < last.end) {
      last.end = Math.max(last.end, item.end);
      last.nodes.push(item.node);
    } else {
      segments.push({ start: item.start, end: item.end, nodes: [item.node] });
    }
  }
  return segments;
}

export function activityOf(node: NodeOut): Activity {
  return {
    llm: node.llm_calls.flatMap((call) => {
      const start = call.start.value;
      const duration = call.duration.value;
      return start === null || duration === null ? [] : [{ start, end: start + duration }];
    }),
    llmTicks: node.llm_calls.filter((call) => call.start.value !== null && call.duration.value === null),
    tools: mergeSegments(node.children.filter((child) => child.kind === "tool")),
    agents: mergeSegments(node.children.filter((child) => child.kind === "agent")),
  };
}

/** Segments with their position in the view; segments outside the view are left out. */
export function placeSegments(segments: Segment[], view: Span): PlacedSegment[] {
  return segments.flatMap((segment) => {
    const geometry = bar(segment.start, segment.end, view);
    return geometry === null ? [] : [{ segment, ...geometry }];
  });
}

/** The segments drawn at `pct` percent of the view. */
export function segmentsAt(placed: PlacedSegment[], pct: number): Segment[] {
  return placed.filter((item) => pct >= item.left && pct <= item.left + item.width).map((item) => item.segment);
}
