// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { cost, makeCall, makeExecutionEvent, makeNode, makeTool, metric } from "../test/factories";
import { groupToolRows, inspectionEntries, inspectionRows } from "./inspectionSequence";

describe("inspection sequence", () => {
  it("projects one row per tool invocation while preserving both source records", () => {
    const tool = makeTool("tool", "Read", { start: metric(2), end: metric(5), duration: metric(3) });
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      children: [tool],
      execution_events: [
        makeExecutionEvent({
          kind: "tool_start",
          event_id: "tool-start:invocation",
          subject_node_id: "tool",
          start: metric(2),
        }),
        makeExecutionEvent({
          kind: "tool_result",
          event_id: "tool-result:invocation",
          subject_node_id: "tool",
          start: metric(5),
          success: false,
        }),
      ],
    });
    const entries = inspectionEntries(owner, owner);
    expect(entries.filter((entry) => entry.kind === "tool")).toHaveLength(1);
    const toolEntry = entries.find((entry) => entry.kind === "tool");
    expect(toolEntry?.kind === "tool" && toolEntry.execution.events).toHaveLength(2);
    expect(groupToolRows(entries).filter((row) => row.kind === "tools")).toHaveLength(1);
  });

  it("places a tool by its start anchor ahead of a later call", () => {
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      llm_calls: [makeCall({ call_id: "later", start: metric(4) })],
      execution_events: [
        makeExecutionEvent({ kind: "tool_start", event_id: "tool-start:early", start: metric(2) }),
        makeExecutionEvent({ kind: "tool_result", event_id: "tool-result:early", start: metric(5) }),
      ],
    });
    expect(inspectionEntries(owner, owner).map((entry) => entry.kind)).toEqual(["tool", "call"]);
  });

  it("retains one invocation in metric-sorted rows and searches source metadata", () => {
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      llm_calls: [makeCall({ call_id: "request", source_request_id: "req", start: metric(1) })],
      execution_events: [
        makeExecutionEvent({
          kind: "tool_start",
          event_id: "tool-start:one",
          start: metric(2),
          links: [{ relation: "requested_by", evidence: "recorded", source_request_id: "req", owner_id: "owner" }],
        }),
        makeExecutionEvent({
          kind: "tool_result",
          event_id: "tool-result:one",
          start: metric(3),
          links: [{ relation: "consumed_by", evidence: "recorded", source_request_id: "next", owner_id: "owner" }],
        }),
      ],
    });
    expect(inspectionRows(owner, owner, "next", "cost", true).filter((row) => row.kind === "tools").length).toBe(1);
    expect(inspectionRows(owner, owner, "missing", "cost", true)).toEqual([]);
  });

  it("filters one invocation while retaining its original contiguous group count", () => {
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      children: [
        makeTool("special", "Read", { topic: "Distinctive source file", start: metric(1) }),
        makeTool("ordinary", "Read", { topic: "Routine source file", start: metric(2) }),
      ],
    });
    const rows = inspectionRows(owner, owner, "distinctive", "chronological", false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "tools", sourceCount: 2 });
    expect(rows[0]?.kind === "tools" && rows[0].executions.map((execution) => execution.subject?.node_id)).toEqual([
      "special",
    ]);
  });

  it("sorts calls while keeping recorded tools with their call and unlinked tools positional", () => {
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      llm_calls: [
        makeCall({ call_id: "first", source_request_id: "first", start: metric(1), cost: cost(1, "USD", "exact", 1) }),
        makeCall({
          call_id: "second",
          source_request_id: "second",
          start: metric(4),
          cost: cost(2, "USD", "exact", 2),
        }),
      ],
      execution_events: [
        makeExecutionEvent({
          kind: "tool_start",
          event_id: "tool-start:recorded",
          subject_node_id: "recorded",
          start: metric(2),
          links: [{ relation: "requested_by", evidence: "recorded", source_request_id: "first", owner_id: "owner" }],
        }),
        makeExecutionEvent({
          kind: "tool_start",
          event_id: "tool-start:positional",
          subject_node_id: "positional",
          start: metric(3),
        }),
      ],
    });
    const rows = inspectionRows(owner, owner, "", "cost", true);
    expect(
      rows.filter((row) => row.kind === "call").map((row) => (row.kind === "call" ? row.originalIndex : -1)),
    ).toEqual([1, 0]);
    const lastRow = rows.at(-1);
    expect(lastRow?.kind).toBe("tools");
    expect(
      lastRow?.kind === "tools" ? lastRow.executions.map((execution) => execution.events[0].event_id) : null,
    ).toEqual(["tool-start:recorded", "tool-start:positional"]);
  });
});
