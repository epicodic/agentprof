// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { EntityRef } from "../lib/entities";
import { callRefs, resolveEntity } from "../lib/entities";
import { makeCall, makeExecutionEvent, makeNode, makeTool, metric, tokens } from "../test/factories";
import { callExpansionKey, eventRowKey, LlmCallsTable, localEventExpansionKey } from "./LlmCallsTable";
import { type SessionInteraction, SessionInteractionContext } from "./SessionInteraction";

function render(
  node: ReturnType<typeof makeNode>,
  focusIndex: number | null = null,
  selection: EntityRef | null = null,
  memory = new Map<string, unknown>(),
) {
  const root = makeNode({ node_id: "root", kind: "session", children: [node] });
  const interaction: SessionInteraction = {
    sessionId: "s",
    root,
    location: { nodeId: node.node_id, tab: "calls", selection, invalidSelection: false },
    resolved: selection === null ? null : resolveEntity(root, "s", selection),
    unavailable: false,
    revealVersion: 0,
    revealTarget: null,
    restoringHistory: false,
    restorationVersion: 0,
    inspectionRequest: null,
    localMark: null,
    clipboardError: false,
    copyLink: () => {},
    selectEntity: () => {},
    markLocal: () => {},
    openEntity: () => {},
    openNode: () => {},
    changeTab: () => {},
    closeDetails: () => {},
    clearSelection: () => {},
    saveSnapshot: () => {},
    memory,
  };
  const table = createElement(LlmCallsTable, {
    node,
    agentStart: 1000,
    focusRequest: focusIndex === null ? null : { kind: "call", ownerId: node.node_id, index: focusIndex },
    onSelect: () => {},
  });
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(SessionInteractionContext.Provider, { value: interaction }, table),
    ),
  );
}

test("uses one compact five-column table and removes mode and raw event actions", () => {
  const node = makeNode({
    node_id: "owner",
    kind: "agent",
    llm_calls: [makeCall({ call_id: "call", start: metric(2000), model: "model-x" })],
    children: [makeTool("tool", "Read", { start: metric(2500) })],
    execution_events: [makeExecutionEvent({ event_id: "message", kind: "message", start: metric(3) })],
  });
  const html = render(node);
  expect(html).toContain(">Time</button>");
  expect(html).toContain(">Item</th>");
  for (const column of ["Duration", "Cost", "Tokens"]) expect(html).toContain(`>${column}</button>`);
  expect(html).toContain('aria-label="Search calls and tools"');
  expect(html).toContain('aria-label="Expand Read"');
  expect(html).toContain('aria-label="Show details: Read"');
  expect(html).toContain('aria-label="Show details: LLM call');
  for (const obsolete of [
    "Compact",
    "All events",
    "Select event",
    "Open event",
    "Select LLM call",
    "Open selected details",
  ])
    expect(html).not.toContain(obsolete);
  expect(html).toContain('data-testid="tool-execution-owner-subject:tool"');
  expect(html.match(/data-testid="tool-execution-owner-subject:tool"/g)).toHaveLength(1);
});

test("expanded call measurements retain all token categories while tool details hide technical records", () => {
  const tool = makeTool("tool", "Bash", { topic: "run tests", start: metric(2200), duration: metric(30) });
  const node = makeNode({
    node_id: "owner",
    kind: "agent",
    children: [tool],
    llm_calls: [
      makeCall({
        call_id: "call",
        start: metric(2000),
        tokens: {
          ...tokens(12, 4),
          cache_read: metric(5),
          cache_write: metric(3),
          cache_write_5m: metric(2),
          cache_write_1h: metric(1),
        },
      }),
    ],
    execution_events: [
      makeExecutionEvent({
        event_id: "tool-start:invoke",
        kind: "tool_start",
        subject_node_id: "tool",
        start: metric(2200),
        links: [
          {
            owner_id: "missing-requester",
            source_request_id: "unresolved-request-id",
            relation: "requested_by",
            evidence: "recorded",
          },
        ],
      }),
      makeExecutionEvent({
        event_id: "tool-result:invoke",
        kind: "tool_result",
        subject_node_id: "tool",
        start: metric(2230),
        success: false,
      }),
      makeExecutionEvent({
        event_id: "tool-start:orphan",
        kind: "tool_start",
        subject_node_id: "missing-subject",
        start: metric(2400),
      }),
      makeExecutionEvent({
        event_id: "activity-evidence",
        kind: "message",
        subject_node_id: "missing-activity-subject",
        start: metric(2500),
        links: [
          {
            owner_id: "missing-activity-owner",
            source_request_id: "activity-request-id",
            relation: "requested_by",
            evidence: "recorded",
          },
        ],
      }),
    ],
  });
  const memory = new Map<string, unknown>([
    ["expand:owner:standalone", [callExpansionKey(callRefs("s", node)[0] ?? null, 0)]],
    ["expand-tools:owner:standalone", ["subject:tool", "invocation:orphan"]],
    ["expand-tool-groups:owner:standalone", ['["subject:tool","invocation:orphan"]']],
    ["expand-activity:owner:standalone", ["activity-evidence"]],
  ]);
  const html = render(node, null, null, memory);
  for (const category of ["Input", "Cache read", "Cache write", "Cache write 5m", "Cache write 1h", "Output"])
    expect(html).toContain(category);
  expect(html).not.toContain("tool-start:invoke");
  expect(html).not.toContain("tool-result:invoke");
  expect(html).not.toContain("<dt>Subject ID</dt><dd>missing-subject</dd>");
  expect(html).toContain("<dt>Subject ID</dt><dd>missing-activity-subject</dd>");
  expect(html).not.toContain("Owner: missing-requester");
  expect(html).not.toContain("Request ID: unresolved-request-id");
  expect(html).toContain("Owner: missing-activity-owner");
  expect(html).toContain("Request ID: activity-request-id");
  expect(html).toContain("failed");
  expect(html).not.toContain("Select event");
  expect(html).not.toContain("Open event");
  expect(html).toContain(">24</p>");
});

test("search controls stay visible with no results and old mode state is not rendered", () => {
  const node = makeNode({
    node_id: "owner",
    execution_events: [makeExecutionEvent({ event_id: "present", kind: "message" })],
  });
  const html = render(
    node,
    null,
    null,
    new Map([["sequence:owner:standalone", { query: "missing", mode: "compact", order: "chronological" }]]),
  );
  expect(html).toContain('data-testid="sequence-controls-owner"');
  expect(html).toContain("No sequence entries match this search.");
  expect(html).toContain("Search calls and tools");
  expect(html).not.toContain("Sequence mode");
});

test("metric-sorted calls explain requester grouping and its positional fallback", () => {
  const node = makeNode({
    node_id: "owner",
    kind: "agent",
    llm_calls: [makeCall({ call_id: "call", start: metric(1) })],
  });
  const sorted = render(
    node,
    null,
    null,
    new Map([["sequence:owner:standalone", { query: "", order: "cost", descending: true }]]),
  );
  expect(sorted).toContain("Tools follow recorded requester links when available");
  expect(sorted).toContain("Position alone does not establish causality.");
  expect(render(node)).not.toContain("Tools follow recorded requester links when available");
});

test("a selected legacy event highlights its one invocation, without expanding on selection", () => {
  const tool = makeTool("tool", "Read", { start: metric(20) });
  const node = makeNode({
    node_id: "owner",
    kind: "agent",
    children: [tool],
    execution_events: [
      makeExecutionEvent({ event_id: "tool-start:invoke", subject_node_id: "tool", start: metric(20) }),
      makeExecutionEvent({
        event_id: "tool-result:invoke",
        kind: "tool_result",
        subject_node_id: "tool",
        start: metric(25),
      }),
      makeExecutionEvent({ event_id: "activity", kind: "message", start: metric(30) }),
    ],
  });
  const selection: EntityRef = { kind: "event", sessionId: "s", ownerId: "owner", eventId: "tool-result:invoke" };
  const html = render(node, null, selection);
  const toolRow = html.match(/data-testid="tool-execution-owner-subject:tool"[^>]*>/)?.[0] ?? "";
  expect(toolRow).toContain('data-selection="exact"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('data-testid="selection-summary"');
});

test("orphan results stay visible as one invocation with Start unavailable", () => {
  const node = makeNode({
    node_id: "owner",
    kind: "agent",
    execution_events: [
      makeExecutionEvent({
        event_id: "tool-result:orphan",
        kind: "tool_result",
        subject_node_id: "missing",
        start: metric(50),
      }),
    ],
  });
  const html = render(node, null, null, new Map([["expand-tools:owner:standalone", ["invocation:orphan"]]]));
  expect(html).toContain('data-testid="tool-execution-owner-invocation:orphan"');
  expect(html).toContain("<dt>Started</dt><dd>Unavailable");
  expect(html).toContain("<dt>Finished</dt><dd>1/1/70, 1:00 AM");
});

test("event identity helpers use stable refs and snapshot-local keys for ambiguous IDs", () => {
  const first = [makeExecutionEvent({ event_id: "duplicate" }), makeExecutionEvent({ event_id: "duplicate" })];
  const refreshed = [...first];
  expect(eventRowKey(null, first, 0)).not.toBe(eventRowKey(null, first, 1));
  expect(localEventExpansionKey(first, 0)).not.toBe(localEventExpansionKey(refreshed, 0));
  expect(callExpansionKey(null, 0)).toBe("call-index:0");
});

test("collapsed call token summary reports accumulated usage", () => {
  const node = makeNode({
    node_id: "owner",
    llm_calls: [makeCall({ tokens: { ...tokens(10, 5), input: metric(10, "estimated") } })],
  });
  expect(render(node)).toContain(">15</p>");
});

test("collapsed tool rows show names only and tool groups list names", () => {
  const read = makeTool("read", "Read", { topic: "Read private arguments", start: metric(2) });
  if (!read.tool) throw new Error("Missing fixture tool");
  read.tool.path = "deep/long/path.py";
  const bash = makeTool("bash", "Bash", { start: metric(4) });
  if (!bash.tool) throw new Error("Missing fixture tool");
  bash.tool.command = "echo complicated arguments";
  const node = makeNode({ node_id: "owner", kind: "agent", children: [read, bash] });
  const grouped = render(node);
  expect(grouped).toContain("Read, Bash");
  const individual = render(
    node,
    null,
    null,
    new Map([["expand-tool-groups:owner:standalone", ['["subject:read","subject:bash"]']]]),
  );
  const row = individual.match(/data-testid="tool-execution-owner-subject:read"[^>]*>(.*?)<\/tr>/s)?.[1];
  expect(row).toBeDefined();
  expect(row).not.toContain("deep/long/path.py");
  expect(row).not.toContain("private arguments");
});

test("expanded tools have readable fields and a real link without source evidence", () => {
  const tool = makeTool("read", "Read", { start: metric(2), duration: metric(4) });
  const node = makeNode({
    node_id: "owner",
    kind: "agent",
    children: [tool],
    execution_events: [
      makeExecutionEvent({
        event_id: "tool-start:invocation",
        subject_node_id: "read",
        start: metric(2),
        source_stream_id: "private-stream",
        source_order: 20,
      }),
    ],
  });
  const html = render(node, null, null, new Map([["expand-tools:owner:standalone", ["subject:read"]]]));
  expect(html).toContain("Open tool details</a>");
  expect(html).toContain("<dt>Started</dt>");
  expect(html).not.toContain("Source evidence");
  expect(html).toContain("Requester");
  expect(html).toContain("Result user");
  expect(html).not.toContain("tool-start:invocation");
  expect(html).not.toContain("tool start · tool-start");
  expect(html).not.toContain("<details open");
});
