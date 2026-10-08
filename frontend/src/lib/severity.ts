// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

const SEVERITY_COLORS: Record<string, string> = { high: "red", medium: "orange", low: "yellow" };

export function severityColor(severity: string): string {
  return SEVERITY_COLORS[severity] ?? "gray";
}
