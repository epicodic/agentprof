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

describe("transcript event invalidation", () => {
  it("invalidates session transcript caches on updates even when the session mtime is current", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { invalidateTranscriptCaches } = await import("./events");
    const client = new QueryClient();
    const key = ["transcript", "s", "page", {}] as const;
    client.setQueryData(key, { entries: ["retained"] });
    await invalidateTranscriptCaches(client, "s");
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryData(key)).toEqual({ entries: ["retained"] });
  });

  it("invalidates all loaded transcript sessions on reconnect", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { invalidateTranscriptCaches } = await import("./events");
    const client = new QueryClient();
    const first = ["transcript", "s1", "page"] as const;
    const second = ["transcript", "s2", "entry"] as const;
    client.setQueryData(first, "one");
    client.setQueryData(second, "two");
    await invalidateTranscriptCaches(client);
    expect(client.getQueryState(first)?.isInvalidated).toBe(true);
    expect(client.getQueryState(second)?.isInvalidated).toBe(true);
    expect(client.getQueryData(first)).toBe("one");
    expect(client.getQueryData(second)).toBe("two");
  });
});
