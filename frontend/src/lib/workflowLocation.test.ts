// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { parseWorkflowLocation, writeWorkflowLocation } from "./workflowLocation";

describe("workflow location", () => {
  it("defaults missing fields and roundtrips encoded native scope IDs", () => {
    expect(parseWorkflowLocation(new URLSearchParams("debug=1"))).toEqual({
      scopeId: null,
      activity: "all",
      invalidActivity: false,
    });
    const params = new URLSearchParams();
    params.set("scope", "agent /雪%?&");
    params.set("activity", "waiting");
    expect(
      parseWorkflowLocation(
        new URLSearchParams(
          writeWorkflowLocation(new URLSearchParams(), { scopeId: params.get("scope"), activity: "waiting" }),
        ),
      ),
    ).toEqual({
      scopeId: "agent /雪%?&",
      activity: "waiting",
      invalidActivity: false,
    });
  });

  it("preserves inspection and unrelated parameters when changing scope", () => {
    const original = new URLSearchParams("node=turn&sel=call&owner=turn&call=id%3Arequest&tab=calls&debug=1");
    const next = writeWorkflowLocation(original, { scopeId: "deep-1" });
    expect(next.get("node")).toBe("turn");
    expect(next.get("call")).toBe("id:request");
    expect(next.get("debug")).toBe("1");
    expect(next.get("scope")).toBe("deep-1");
    expect(original.has("scope")).toBe(false);
  });

  it("preserves invalid untouched query fields and only omits all when explicitly changed", () => {
    const rawActivity = new URLSearchParams("scope=bad%2Fscope&activity=bogus&node=n");
    expect(parseWorkflowLocation(rawActivity)).toEqual({
      scopeId: "bad/scope",
      activity: "all",
      invalidActivity: true,
    });
    expect(writeWorkflowLocation(rawActivity, { scopeId: "valid" }).get("activity")).toBe("bogus");
    expect(writeWorkflowLocation(rawActivity, { activity: "running" }).get("scope")).toBe("bad/scope");
    expect(writeWorkflowLocation(rawActivity, { activity: "all" }).has("activity")).toBe(false);
    expect(writeWorkflowLocation(rawActivity, { scopeId: null }).has("scope")).toBe(false);
    expect(writeWorkflowLocation(rawActivity, {}).toString()).toBe(rawActivity.toString());
  });

  it("normalizes an empty scope to absent without rewriting it during an activity patch", () => {
    const params = new URLSearchParams("scope=&activity=waiting&debug=1");
    expect(parseWorkflowLocation(params).scopeId).toBeNull();
    expect(writeWorkflowLocation(params, { activity: "running" }).has("scope")).toBe(true);
    expect(writeWorkflowLocation(params, { activity: "running" }).get("scope")).toBe("");
    expect(params.toString()).toBe("scope=&activity=waiting&debug=1");
  });
});
