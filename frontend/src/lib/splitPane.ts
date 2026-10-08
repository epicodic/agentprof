// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

const DEFAULT_SPLIT_PERCENT = 75;
const MIN_TREE_PERCENT = 15;
const MAX_TREE_PERCENT = 85;

function clampPercent(value: number): number {
  return Math.min(MAX_TREE_PERCENT, Math.max(MIN_TREE_PERCENT, value));
}

export function initialSplitPercent(persisted: string | null): number {
  if (persisted === null) return DEFAULT_SPLIT_PERCENT;
  const value = Number(persisted);
  return Number.isFinite(value) && value >= MIN_TREE_PERCENT && value <= MAX_TREE_PERCENT
    ? value
    : DEFAULT_SPLIT_PERCENT;
}

export function splitPercentAfterDrag(pointerY: number, containerHeight: number): number {
  if (containerHeight <= 0) return DEFAULT_SPLIT_PERCENT;
  return clampPercent((pointerY / containerHeight) * 100);
}
