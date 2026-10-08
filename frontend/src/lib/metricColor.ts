// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

export interface MetricScale {
  p90: number;
}

const GREEN = [92, 151, 106] as const;
const YELLOW = [166, 137, 50] as const;
const RED = [183, 108, 108] as const;

export function metricScale(values: readonly (number | null | undefined)[]): MetricScale | null {
  const known = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (known.length === 0) return null;

  known.sort((a, b) => a - b);
  const rank = (known.length - 1) * 0.9;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return { p90: known[lower] + (known[upper] - known[lower]) * (rank - lower) };
}

export function colorForMetric(value: number | null | undefined, scale: MetricScale | null): string | null {
  if (value == null || scale == null) return null;
  if (scale.p90 === 0) return formatColor(value === 0 ? GREEN : RED);

  const position = Math.max(0, Math.min(1, value / scale.p90));
  if (position <= 0.5) return interpolateColor(GREEN, YELLOW, position * 2);
  return interpolateColor(YELLOW, RED, (position - 0.5) * 2);
}

function interpolateColor(from: readonly number[], to: readonly number[], amount: number): string {
  return formatColor(from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount)));
}

function formatColor(channels: readonly number[]): string {
  return `rgb(${channels.join(", ")})`;
}
