// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { chartBarHeight, chartScale } from "./chartScale";

describe("chartScale", () => {
  it("chooses a rounded ceiling with zero and a few positive guides", () => {
    expect(chartScale(7)).toEqual({ maximum: 10, step: 5, ticks: [0, 5, 10] });
    expect(chartScale(1200, 1)).toEqual({ maximum: 1500, step: 500, ticks: [0, 500, 1000, 1500] });
  });

  it("keeps a minimum whole-token step for small token ranges", () => {
    expect(chartScale(2, 1)).toEqual({ maximum: 2, step: 1, ticks: [0, 1, 2] });
  });

  it("scales very small costs to distinct decimal values", () => {
    expect(chartScale(0.00003)).toEqual({
      maximum: 0.00003,
      step: 0.00001,
      ticks: [0, 0.00001, 0.00002, 0.00003],
    });
    expect(chartScale(0.00000000000003)).toEqual({
      maximum: 0.00000000000003,
      step: 0.00000000000001,
      ticks: [0, 0.00000000000001, 0.00000000000002, 0.00000000000003],
    });
  });

  it("keeps a zero tick and no guides when there are no positive values", () => {
    expect(chartScale(0)).toEqual({ maximum: 0, step: 0, ticks: [0] });
    expect(chartScale(Number.NaN)).toEqual({ maximum: 0, step: 0, ticks: [0] });
  });
});

describe("chartBarHeight", () => {
  it("uses the plot height for value geometry while preserving zero and tiny-bar behavior", () => {
    expect(chartBarHeight(4, 10, 90)).toBe(36);
    expect(chartBarHeight(0, 10, 90)).toBe(0);
    expect(chartBarHeight(0.01, 10, 90)).toBe(2);
  });
});
