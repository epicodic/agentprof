// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { makeNode, makeSession, makeSummary } from "../test/factories";
import { applyRemoval, applyUpdate, isStale } from "./events";

describe("applyUpdate", () => {
  it("replaces or adds a row and keeps the newest first", () => {
    const rows = [makeSummary({ id: "a", mtime: 2 }), makeSummary({ id: "b", mtime: 1 })];

    const updated = applyUpdate(rows, makeSummary({ id: "b", mtime: 3, title: "new" }));

    expect(updated?.map((r) => [r.id, r.title])).toEqual([
      ["b", "new"],
      ["a", "a"],
    ]);
    expect(applyUpdate(rows, makeSummary({ id: "c", mtime: 0 }))?.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves an unloaded list alone", () => {
    expect(applyUpdate(undefined, makeSummary({ id: "a" }))).toBeUndefined();
  });
});

describe("applyRemoval", () => {
  it("drops the row", () => {
    expect(applyRemoval([makeSummary({ id: "a" }), makeSummary({ id: "b" })], "a")?.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("isStale", () => {
  it("is true only for a loaded session older than the event", () => {
    const session = makeSession(makeNode({ node_id: "session", kind: "session" }), 10);

    expect(isStale(session, makeSummary({ id: "claude-code:s", mtime: 11 }))).toBe(true);
    expect(isStale(session, makeSummary({ id: "claude-code:s", mtime: 10 }))).toBe(false);
    expect(isStale(undefined, makeSummary({ id: "claude-code:s", mtime: 11 }))).toBe(false);
  });
});
