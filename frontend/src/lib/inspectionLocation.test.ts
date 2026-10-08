// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import type { EntityRef } from "./entities";
import { detailTab, parseInspection, writeInspection } from "./inspectionLocation";

const parse = (search: string, sessionId = "session /é"): ReturnType<typeof parseInspection> =>
  parseInspection(sessionId, new URLSearchParams(search));

describe("detailTab", () => {
  it("defaults tool nodes to content and non-tool nodes to overview", () => {
    expect(detailTab("tool", null)).toBe("content");
    expect(detailTab("tool", "overview")).toBe("overview");
    expect(detailTab("agent", null)).toBe("overview");
    expect(detailTab("tool", "calls")).toBe("content");
    expect(detailTab("agent", "workflow")).toBe("workflow");
  });
});

describe("parseInspection", () => {
  it("parses a legacy node and recognized tab without a selection", () => {
    expect(parse("node=n&tab=calls&debug=1")).toEqual({
      nodeId: "n",
      tab: "calls",
      selection: null,
      invalidSelection: false,
    });
  });

  it("parses native node IDs with spaces, Unicode and percent characters", () => {
    const nodeId = "node /雪%";
    const params = new URLSearchParams();
    params.set("sel", "node");
    params.set("entity", nodeId);
    expect(parseInspection("s /雪", params)).toEqual({
      nodeId: null,
      tab: null,
      selection: { kind: "node", sessionId: "s /雪", nodeId },
      invalidSelection: false,
    });
  });

  it("parses call selections while retaining unrelated parameters and input params", () => {
    const params = new URLSearchParams("sel=call&owner=a%26b&call=id%3Ax%3A%2F%3F%2B&debug=1");
    const before = params.toString();
    expect(parseInspection("s", params)).toEqual({
      nodeId: null,
      tab: null,
      selection: { kind: "call", sessionId: "s", ownerId: "a&b", callKey: "id:x:/?+" },
      invalidSelection: false,
    });
    expect(params.toString()).toBe(before);
  });

  it("roundtrips event selections and rejects incomplete event selections", () => {
    const selection: EntityRef = { kind: "event", sessionId: "s", ownerId: "root", eventId: "tool-result:t/1" };
    const written = writeInspection(new URLSearchParams("debug=1&sel=call&owner=o&call=id%3Ax"), {
      nodeId: null,
      tab: null,
      selection,
      invalidSelection: false,
    });
    expect(written.toString()).toBe("debug=1&sel=event&owner=root&event=tool-result%3At%2F1");
    expect(parseInspection("s", written).selection).toEqual(selection);
    for (const search of ["sel=event", "sel=event&owner=o", "sel=event&event=e", "sel=event&owner=o&event="]) {
      const parsed = parse(search);
      expect(parsed.selection, search).toBeNull();
      expect(parsed.invalidSelection, search).toBe(true);
    }
  });

  it("accepts only canonical finite timestamp call keys", () => {
    expect(parse("sel=call&owner=o&call=time%3A1.5").selection).toEqual({
      kind: "call",
      sessionId: "session /é",
      ownerId: "o",
      callKey: "time:1.5",
    });
    for (const call of ["time:", "time:NaN", "time:Infinity", "time:01", "time:1.0", "time:1e0"]) {
      const result = parse(`sel=call&owner=o&call=${encodeURIComponent(call)}`);
      expect(result.selection, call).toBeNull();
      expect(result.invalidSelection, call).toBe(true);
    }
  });

  it("marks empty, unknown, and incomplete selection selectors invalid", () => {
    for (const search of ["sel=", "sel=other", "owner=o", "call=id%3Ax", "entity=n"]) {
      expect(parse(search).selection, search).toBeNull();
      expect(parse(search).invalidSelection, search).toBe(true);
    }
    expect(parse("sel=node&entity=").invalidSelection).toBe(true);
    expect(parse("sel=call&owner=&call=id%3Ax").invalidSelection).toBe(true);
  });

  it("defaults an invalid tab to null and does not mutate params", () => {
    const params = new URLSearchParams("node=n&tab=bogus&debug=1");
    const before = params.toString();
    expect(parseInspection("s", params)).toMatchObject({ nodeId: "n", tab: null, invalidSelection: false });
    expect(params.toString()).toBe(before);
  });
});

describe("writeInspection", () => {
  it("serializes and reparses call keys exactly while preserving unrelated parameters", () => {
    const selection: EntityRef = { kind: "call", sessionId: "s", ownerId: "a&b", callKey: "id:x:/?+" };
    const original = new URLSearchParams("node=stale&tab=overview&sel=node&entity=stale&debug=1");
    const written = writeInspection(original, { nodeId: "n", tab: "workflow", selection, invalidSelection: false });
    expect(written.toString()).toBe("debug=1&node=n&tab=workflow&sel=call&owner=a%26b&call=id%3Ax%3A%2F%3F%2B");
    expect(parseInspection("s", written).selection).toEqual(selection);
    expect(original.toString()).toBe("node=stale&tab=overview&sel=node&entity=stale&debug=1");
  });

  it("clears the selection while retaining the inspected node, tab and unrelated parameters", () => {
    const written = writeInspection(new URLSearchParams("sel=call&owner=o&call=id%3Ax&debug=1"), {
      nodeId: "n",
      tab: "content",
      selection: null,
      invalidSelection: false,
    });
    expect(written.toString()).toBe("debug=1&node=n&tab=content");
  });

  it("clears all event selection fields while preserving unrelated parameters", () => {
    const cleared = writeInspection(new URLSearchParams("sel=event&owner=o&event=e&debug=1"), {
      nodeId: null,
      tab: null,
      selection: null,
      invalidSelection: false,
    });
    expect(cleared.toString()).toBe("debug=1");
  });

  it("preserves malformed event selections during unrelated location changes", () => {
    const malformed = new URLSearchParams("sel=event&owner=o&event=&debug=1");
    const parsed = parseInspection("s", malformed);
    const changed = writeInspection(malformed, { ...parsed, nodeId: "n", tab: "overview" });
    expect(changed.get("sel")).toBe("event");
    expect(changed.get("event")).toBe("");
    expect(changed.get("debug")).toBe("1");
  });

  it("closes the inspected node and tab while retaining a valid selection", () => {
    const selection: EntityRef = { kind: "node", sessionId: "s", nodeId: "picked" };
    const written = writeInspection(new URLSearchParams("node=n&tab=workflow&debug=1"), {
      nodeId: null,
      tab: "workflow",
      selection,
      invalidSelection: false,
    });
    expect(written.toString()).toBe("debug=1&sel=node&entity=picked");
  });

  it("serializes a node selection after removing stale call parameters", () => {
    const selection: EntityRef = { kind: "node", sessionId: "s", nodeId: "picked" };
    const written = writeInspection(new URLSearchParams("owner=old&call=id%3Aold&entity=old&sel=call"), {
      nodeId: "inspect",
      tab: "overview",
      selection,
      invalidSelection: false,
    });
    expect(written.toString()).toBe("node=inspect&tab=overview&sel=node&entity=picked");
  });

  it("preserves malformed raw selection parameters on tab changes and drawer close", () => {
    const malformed = new URLSearchParams("sel=call&owner=o&call=time%3A&debug=1");
    const parsed = parseInspection("s", malformed);
    const changedTab = writeInspection(malformed, { ...parsed, nodeId: "n", tab: "content" });
    expect(changedTab.get("sel")).toBe("call");
    expect(changedTab.get("call")).toBe("time:");
    const closed = writeInspection(changedTab, { ...parsed, nodeId: null, tab: null });
    expect(closed.get("sel")).toBe("call");
    expect(closed.get("call")).toBe("time:");
    const cleared = writeInspection(closed, { ...parsed, nodeId: null, tab: null, invalidSelection: false });
    expect(cleared.get("sel")).toBeNull();
    expect(cleared.get("owner")).toBeNull();
    expect(cleared.get("call")).toBeNull();
    expect(cleared.get("debug")).toBe("1");
  });

  it("writes a tab only while a node is inspected", () => {
    const closed = writeInspection(new URLSearchParams("node=n&tab=calls"), {
      nodeId: null,
      tab: "calls",
      selection: null,
      invalidSelection: false,
    });
    expect(closed.toString()).toBe("");
  });
});
