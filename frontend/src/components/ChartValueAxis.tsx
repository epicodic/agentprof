// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Box, Text } from "@mantine/core";
import type { ReactNode } from "react";
import type { ChartScale } from "../lib/chartScale";
import { formatTokens } from "../lib/format";
import type { Span } from "../lib/timeline";
import { AxisLabels } from "./AxisLabels";
import { TIMELINE_LABEL_WIDTH } from "./NodeTimeline";

export const CHART_HEIGHT = 90;

function formatUsd(value: number, step: number): string {
  if (step === 0) return "$0.00";
  const places = Math.max(0, -Math.floor(Math.log10(step)));
  return places <= 100 ? `$${value.toFixed(places)}` : `$${value.toExponential(6)}`;
}

function formatValue(value: number, scale: ChartScale, format: "usd" | "tokens"): string {
  return format === "usd" ? formatUsd(value, scale.step) : formatTokens(value);
}

/** A zero-based value axis, faint guides, and an elapsed axis over one aligned plot. */
export function ChartValueAxis({
  unit,
  scale,
  format,
  view,
  origin,
  chartTestId,
  children,
}: {
  unit: string;
  scale: ChartScale;
  format: "usd" | "tokens";
  view: Span;
  origin: number;
  chartTestId: string;
  children: ReactNode;
}) {
  return (
    <Box style={{ display: "grid", gridTemplateColumns: `${TIMELINE_LABEL_WIDTH}px 1fr`, alignItems: "stretch" }}>
      <Text size="xs" c="dimmed">
        {unit}
      </Text>
      <Box data-testid="chart-time-axis" px={4}>
        <AxisLabels view={view} origin={origin} />
      </Box>
      <Box pos="relative" h={CHART_HEIGHT}>
        {scale.ticks.map((value) => {
          const pct = scale.maximum === 0 ? 0 : (value / scale.maximum) * 100;
          return (
            <Text
              key={value}
              data-testid="chart-value-label"
              data-value={value}
              data-pct={pct}
              size="xs"
              c="dimmed"
              pos="absolute"
              style={{
                right: 4,
                ...(value === 0
                  ? { bottom: 0, transform: "translateY(50%)" }
                  : { top: `${100 - pct}%`, transform: "translateY(-50%)" }),
                whiteSpace: "nowrap",
                lineHeight: 1,
              }}
            >
              {formatValue(value, scale, format)}
            </Text>
          );
        })}
      </Box>
      <Box
        data-testid={chartTestId}
        pos="relative"
        h={CHART_HEIGHT}
        mx={4}
        style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
      >
        {children}
        {scale.ticks
          .filter((value) => value > 0)
          .map((value) => {
            const pct = (value / scale.maximum) * 100;
            return (
              <Box
                key={value}
                data-testid="chart-value-guide"
                data-value={value}
                data-pct={pct}
                pos="absolute"
                left={0}
                right={0}
                style={{
                  top: `${100 - pct}%`,
                  borderTop: "1px solid var(--mantine-color-default-border)",
                  pointerEvents: "none",
                  zIndex: 2,
                }}
              />
            );
          })}
      </Box>
    </Box>
  );
}
