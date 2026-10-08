// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { clampPage, DEFAULT_PAGE_SIZE, pageCount, parsePageSize } from "./paging";

describe("parsePageSize", () => {
  it("accepts an offered size and falls back to the default otherwise", () => {
    expect(parsePageSize("100")).toBe(100);
    expect(parsePageSize(null)).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize("37")).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize("junk")).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("pageCount", () => {
  it("rounds up and never drops below one page", () => {
    expect(pageCount(101, 50)).toBe(3);
    expect(pageCount(100, 50)).toBe(2);
    expect(pageCount(0, 50)).toBe(1);
  });
});

describe("clampPage", () => {
  it("keeps a page that still exists and moves past-the-end pages to the last one", () => {
    expect(clampPage(1, 120, 50)).toBe(1);
    expect(clampPage(4, 120, 50)).toBe(2);
    expect(clampPage(3, 0, 50)).toBe(0);
  });
});
