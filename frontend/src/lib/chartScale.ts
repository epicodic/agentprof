// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

export interface ChartScale {
  maximum: number;
  step: number;
  ticks: number[];
}

/** Bar height for a value on the chart's zero-based scale, preserving visibility for small positive values. */
export function chartBarHeight(value: number, maximum: number, plotHeight: number): number {
  if (value === 0) return 0;
  return maximum > 0 ? Math.max(2, (value / maximum) * plotHeight) : 2;
}

function niceStepAtLeast(minimum: number): number {
  const power = 10 ** Math.floor(Math.log10(minimum));
  for (const factor of [1, 2, 5, 10]) {
    const step = factor * power;
    if (step >= minimum) return step;
  }
  return 10 * power;
}

/** A zero-based scale with a rounded ceiling and roughly three intervals. */
export function chartScale(maximum: number, minimumStep = 0): ChartScale {
  if (!Number.isFinite(maximum) || maximum <= 0) return { maximum: 0, step: 0, ticks: [0] };

  const step = niceStepAtLeast(Math.max(maximum / 3, minimumStep));
  const ratio = maximum / step;
  const intervalCount = Math.max(1, Math.ceil(ratio - Number.EPSILON * Math.abs(ratio) * 4));
  const round = (value: number) => Number(value.toPrecision(12));
  const roundedMaximum = round(intervalCount * step);
  return {
    maximum: roundedMaximum,
    step,
    ticks: Array.from({ length: intervalCount + 1 }, (_, index) => round(index * step)),
  };
}
