// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { colorForMetric, metricScale } from "./metricColor";

describe("metricScale", () => {
  it("interpolates the 90th percentile of sorted finite values", () => {
    expect(metricScale([20, null, 0, undefined, 10, Number.NaN, Number.POSITIVE_INFINITY])).toEqual({
      p90: 18,
    });
  });

  it("interpolates the 90th percentile for an even count", () => {
    expect(metricScale([30, 0, 20, 10])).toEqual({ p90: 27 });
  });

  it("uses the only value for a single observation", () => {
    expect(metricScale([7])).toEqual({ p90: 7 });
  });

  it("retains zero", () => {
    expect(metricScale([null, undefined, 0])).toEqual({ p90: 0 });
  });

  it("returns null when no finite values are available", () => {
    expect(metricScale([])).toBeNull();
    expect(metricScale([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).toBeNull();
  });

  it("does not reorder the input values", () => {
    const values = [30, 0, 20, 10];
    metricScale(values);
    expect(values).toEqual([30, 0, 20, 10]);
  });
});

describe("colorForMetric", () => {
  it("interpolates from zero to the 90th percentile and clamps higher values", () => {
    const scale = { p90: 20 };

    expect(colorForMetric(0, scale)).toBe("rgb(92, 151, 106)");
    expect(colorForMetric(5, scale)).toBe("rgb(129, 144, 78)");
    expect(colorForMetric(10, scale)).toBe("rgb(166, 137, 50)");
    expect(colorForMetric(15, scale)).toBe("rgb(175, 123, 79)");
    expect(colorForMetric(20, scale)).toBe("rgb(183, 108, 108)");
    expect(colorForMetric(25, scale)).toBe("rgb(183, 108, 108)");
    expect(colorForMetric(-1, scale)).toBe("rgb(92, 151, 106)");
  });

  it("returns null for missing values or scales", () => {
    expect(colorForMetric(null, { p90: 1 })).toBeNull();
    expect(colorForMetric(undefined, { p90: 1 })).toBeNull();
    expect(colorForMetric(1, null)).toBeNull();
  });

  it("uses green for zero and red for positive values when the p90 is zero", () => {
    expect(colorForMetric(0, { p90: 0 })).toBe("rgb(92, 151, 106)");
    expect(colorForMetric(0.01, { p90: 0 })).toBe("rgb(183, 108, 108)");
    expect(colorForMetric(10, { p90: 0 })).toBe("rgb(183, 108, 108)");
  });
});
