// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Box, Text } from "@mantine/core";
import { axisLabels, type Span } from "../lib/timeline";

/** Keep the outer axis labels inside the column: the first starts at the left edge, the last ends at the right. */
function labelShift(pct: number): string {
  if (pct <= 0) return "0";
  if (pct >= 100) return "-100%";
  return "-50%";
}

/** Evenly spaced time labels for `view`, as time since `origin`. */
export function AxisLabels({ view, origin }: { view: Span; origin: number }) {
  return (
    <Box pos="relative" h={14}>
      {axisLabels(view, origin).map((label) => (
        <Text
          key={label.pct}
          size="10px"
          c="dimmed"
          pos="absolute"
          style={{ left: `${label.pct}%`, transform: `translateX(${labelShift(label.pct)})`, whiteSpace: "nowrap" }}
        >
          {label.label}
        </Text>
      ))}
    </Box>
  );
}
