// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

export const PAGE_SIZES = [25, 50, 100, 200];
export const DEFAULT_PAGE_SIZE = 50;

/** A page size read back from storage, or the default if it is missing or not one of `PAGE_SIZES`. */
export function parsePageSize(stored: string | null): number {
  const size = Number(stored);
  return PAGE_SIZES.includes(size) ? size : DEFAULT_PAGE_SIZE;
}

/** The number of pages for `rowCount` rows; at least one, so an empty list still has a page. */
export function pageCount(rowCount: number, pageSize: number): number {
  return Math.max(1, Math.ceil(rowCount / pageSize));
}

/** `pageIndex` moved onto the last page when rows have vanished beneath it. */
export function clampPage(pageIndex: number, rowCount: number, pageSize: number): number {
  return Math.min(pageIndex, pageCount(rowCount, pageSize) - 1);
}
