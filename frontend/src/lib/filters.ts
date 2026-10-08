// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { SummaryOut } from "../api/types";
import { type MetricScale, metricScale } from "./metricColor";

export interface ListFilter {
  agent: string | null;
  workspace: string | null;
  text: string;
}

export function filterRows(rows: SummaryOut[], filter: ListFilter): SummaryOut[] {
  const text = filter.text.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (filter.agent === null || row.agent === filter.agent) &&
      (filter.workspace === null || row.workspace === filter.workspace) &&
      (text === "" || [row.title, row.workspace ?? "", row.id].some((value) => value.toLowerCase().includes(text))),
  );
}

export function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort();
}

export function durationMs(row: SummaryOut): number | null {
  return row.start_ms !== null && row.end_ms !== null ? row.end_ms - row.start_ms : null;
}

export function sessionListMetricScales(rows: readonly SummaryOut[]): {
  duration: MetricScale | null;
  cost: MetricScale | null;
} {
  return {
    duration: metricScale(rows.map(durationMs)),
    cost: metricScale(rows.map((row) => row.cost_total?.usd)),
  };
}
