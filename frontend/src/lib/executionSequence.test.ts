// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import type { ExecutionEventOut } from "../api/types";
import { cost, makeCall, makeExecutionEvent, makeNode, metric, tokens } from "../test/factories";
import {
  callSortValue,
  compactSequence,
  entryTime,
  executionBundles,
  executionGroupMetrics,
  flattenSequenceRows,
  searchExecutionBundles,
  searchTextForEvent,
  sequenceEntries,
} from "./executionSequence";

const fixture = makeNode({
  node_id: "u1",
  kind: "turn",
  llm_calls: [
    makeCall({ call_id: "m1", source_request_id: "m1", start: metric(1000) }),
    makeCall({ call_id: "m2", source_request_id: "m2", start: metric(2000) }),
    makeCall({ call_id: "m3", source_request_id: "m3", start: metric(5000) }),
  ],
  execution_events: [
    makeExecutionEvent({
      event_id: "tool-start:t1",
      start: metric(1100),
      subject_node_id: "t1",
      execution_start: metric(1100),
      execution_end: metric(4100),
    }),
    makeExecutionEvent({
      event_id: "tool-start:t2",
      start: metric(1200),
      subject_node_id: "t2",
      execution_start: metric(1200),
      execution_end: metric(3200),
    }),
    makeExecutionEvent({
      event_id: "tool-result:t2",
      kind: "tool_result",
      start: metric(3200),
      subject_node_id: "t2",
      execution_start: metric(1200),
      execution_end: metric(3200),
      success: false,
    }),
    makeExecutionEvent({
      event_id: "tool-result:t1",
      kind: "tool_result",
      start: metric(4100),
      subject_node_id: "t1",
      execution_start: metric(1100),
      execution_end: metric(4100),
    }),
    makeExecutionEvent({ event_id: "tool-start:unknown", subject_node_id: "unknown" }),
  ],
});

describe("execution sequence", () => {
  it("chronologically orders calls and events and conserves entries when compacted", () => {
    const entries = sequenceEntries(fixture);
    expect(entries.map(entryTime)).toEqual([1000, 1100, 1200, 2000, 3200, 4100, 5000, null]);
    expect(flattenSequenceRows(compactSequence(entries))).toHaveLength(8);
    expect(flattenSequenceRows(compactSequence(entries))).toEqual(entries);
  });

  it("sorts invalid and missing times last and keeps tied entries deterministic", () => {
    const node = makeNode({
      node_id: "u",
      llm_calls: [
        makeCall({ call_id: "untimed" }),
        makeCall({ call_id: "bad", start: metric(Number.NaN) }),
        makeCall({ call_id: "negative", start: metric(-1) }),
        makeCall({ call_id: "tie", start: metric(5) }),
      ],
      execution_events: [
        makeExecutionEvent({ event_id: "same", start: metric(5), source_order: 0, source_stream_id: "s" }),
        makeExecutionEvent({ event_id: "same", start: metric(Number.NaN), source_order: 2, source_stream_id: "s" }),
      ],
    });
    expect(sequenceEntries(node).map(entryTime)).toEqual([5, 5, null, null, null, null]);
    expect(sequenceEntries(node).map((e) => `${e.kind}:${e.originalIndex}`)).toEqual([
      "call:3",
      "event:0",
      "call:0",
      "call:1",
      "call:2",
      "event:1",
    ]);
    expect(entryTime(sequenceEntries(node)[4])).toBeNull();
  });

  it("splits consecutive event groups around calls and between known and unknown time", () => {
    const rows = compactSequence(sequenceEntries(fixture));
    expect(rows.map((row) => row.kind)).toEqual(["call", "group", "call", "group", "call", "group"]);
    expect(flattenSequenceRows(compactSequence([]))).toEqual([]);
    expect(sequenceEntries(makeNode({ node_id: "empty" }))).toEqual([]);
  });
});

describe("execution sequence sorting, search and bundles", () => {
  it("uses only available finite metrics and sums the four token categories once", () => {
    expect(callSortValue(makeCall({ cost: cost(3, "USD") }), "cost")).toBe(3);
    expect(callSortValue(makeCall({ tokens: tokens(100, 10) }), "tokens")).toBeNull();
    expect(callSortValue(makeCall({ cost: cost() }), "cost")).toBeNull();
    expect(callSortValue(makeCall({ cost: cost(4, "credits") }), "cost")).toBeNull();
    expect(
      callSortValue(
        makeCall({
          tokens: {
            input: metric(1),
            output: metric(2),
            cache_read: metric(3),
            cache_write: metric(4),
            cache_write_5m: metric(50),
            cache_write_1h: metric(60),
          },
        }),
        "tokens",
      ),
    ).toBe(10);
    expect(callSortValue(makeCall({ duration: metric(Number.POSITIVE_INFINITY) }), "duration")).toBeNull();
  });

  it("searches stable event metadata with case folding and excludes body text", () => {
    const event = makeExecutionEvent({
      kind: "tool_result",
      event_id: "tool-result:READ-7",
      subject_node_id: "file-node",
    });
    expect(searchTextForEvent(event, null)).toContain("tool result");
    const root = makeNode({
      node_id: "root",
      children: [
        makeNode({
          node_id: "file-node",
          topic: "Read Config",
          tool: { native_id: "read_file", category: "file" } as never,
        }),
      ],
    });
    const text = searchTextForEvent(
      makeExecutionEvent({
        kind: "tool_start",
        event_id: "cmd:READ-7",
        subject_node_id: "file-node",
      }),
      root.children[0],
    );
    expect(text).toContain("read config");
    expect(text).toContain("read_file");
    expect(text).toContain("read-7");
    const toolSubject = makeNode({
      node_id: "tool",
      tool: {
        native_id: "shell",
        category: "shell",
        command: "git status",
        path: "/tmp/settings.json",
        paths: ["/tmp/settings.json"],
      } as never,
    });
    const metadataText = searchTextForEvent(
      makeExecutionEvent({
        event_id: "command:7",
        source_stream_id: "source-stream-9",
        links: [
          { owner_id: "owner", source_request_id: "request-abc", relation: "requested_by", evidence: "recorded" },
        ],
      }),
      toolSubject,
    );
    expect(metadataText).toContain("git status");
    expect(metadataText).toContain("/tmp/settings.json");
    expect(metadataText).toContain("request-abc");
    expect(metadataText).toContain("source-stream-9");
    expect(searchTextForEvent(event, root)).not.toContain("result body");
    expect(searchTextForEvent(makeExecutionEvent(), null)).not.toContain("secret prompt");
  });

  it("keeps late linked results with their request call and unlinked leading and untimed events positioned", () => {
    const call = makeCall({ call_id: "m1", source_request_id: "req-1", start: metric(100) });
    const node = makeNode({
      node_id: "owner",
      llm_calls: [call],
      execution_events: [
        makeExecutionEvent({ event_id: "leading", kind: "user_input", start: metric(10) }),
        makeExecutionEvent({ event_id: "positioned", start: metric(150) }),
        makeExecutionEvent({
          event_id: "linked-sibling",
          start: metric(175),
          links: [
            {
              owner_id: "owner",
              source_request_id: "req-1",
              relation: "requested_by",
              evidence: "recorded",
            },
          ],
        }),
        makeExecutionEvent({
          event_id: "late",
          kind: "tool_result",
          start: metric(200),
          links: [
            {
              owner_id: "owner",
              source_request_id: "req-1",
              relation: "requested_by",
              evidence: "recorded",
            },
          ],
        }),
        makeExecutionEvent({ event_id: "untimed", start: metric(null) }),
      ],
    });
    const bundles = executionBundles(node);
    expect(
      bundles.map((bundle) =>
        bundle.entries.map((entry) => (entry.kind === "event" ? entry.event.event_id : entry.call.call_id)),
      ),
    ).toEqual([
      ["leading", "untimed"],
      ["m1", "positioned", "linked-sibling", "late"],
    ]);
    expect(bundles[1].call?.originalIndex).toBe(0);
    expect(bundles[1].entries.filter((entry) => entry.kind === "event").map((entry) => entry.displayLabel)).toEqual([
      "Positioned after call; request relationship unavailable",
      undefined,
      undefined,
    ]);
    const all = bundles.flatMap((bundle) => bundle.entries);
    expect(all.filter((entry) => entry.kind === "event")).toHaveLength(5);
    expect(all.filter((entry) => entry.kind === "call").map((entry) => entry.originalIndex)).toEqual([0]);
  });

  it("sorts unavailable metrics last and keeps stable ties and duplicate requests unlinked", () => {
    const node = makeNode({
      node_id: "owner",
      llm_calls: [
        makeCall({ call_id: "tie-a", start: metric(10), cost: cost(2, "USD") }),
        makeCall({ call_id: "tie-b", start: metric(20), cost: cost(2, "USD") }),
        makeCall({ call_id: "none", start: metric(30), cost: cost() }),
        makeCall({ call_id: "dupe", source_request_id: "same", start: metric(40) }),
        makeCall({ call_id: "dupe2", source_request_id: "same", start: metric(50) }),
      ],
      execution_events: [
        makeExecutionEvent({
          event_id: "orphan",
          start: metric(60),
          links: [
            {
              owner_id: "owner",
              source_request_id: "same",
              relation: "requested_by",
              evidence: "recorded",
            },
          ],
        }),
      ],
    });
    const bundles = executionBundles(node, "cost");
    expect(bundles.map((bundle) => bundle.call?.call.call_id ?? "leading")).toEqual([
      "tie-a",
      "tie-b",
      "none",
      "dupe",
      "dupe2",
    ]);
    expect(bundles.at(-1)?.entries.find((entry) => entry.kind === "event")?.displayLabel).toBe(
      "Positioned after call; request relationship unavailable",
    );
    expect(bundles.flatMap((bundle) => bundle.entries).filter((entry) => entry.kind === "event")).toHaveLength(1);
  });

  it("uses positional assignment when one event has multiple distinct recorded requesters", () => {
    const node = makeNode({
      node_id: "owner",
      llm_calls: [
        makeCall({ call_id: "first", source_request_id: "req-1", start: metric(10) }),
        makeCall({ call_id: "second", source_request_id: "req-2", start: metric(20) }),
      ],
      execution_events: [
        makeExecutionEvent({
          event_id: "ambiguous",
          start: metric(30),
          links: [
            { owner_id: "owner", source_request_id: "req-1", relation: "requested_by", evidence: "recorded" },
            { owner_id: "owner", source_request_id: "req-2", relation: "requested_by", evidence: "recorded" },
          ],
        }),
      ],
    });
    const bundles = executionBundles(node);
    expect(
      bundles.map((bundle) =>
        bundle.entries.map((entry) => (entry.kind === "event" ? entry.event.event_id : entry.call.call_id)),
      ),
    ).toEqual([["first"], ["second", "ambiguous"]]);
    expect(bundles[1].entries.at(-1)).toMatchObject({
      kind: "event",
      displayLabel: "Positioned after call; request relationship unavailable",
    });
  });

  it("filters by metadata, keeps qualified anchors, and returns no context for zero matches", () => {
    const node = makeNode({
      node_id: "owner",
      llm_calls: [
        makeCall({ call_id: "m1", source_request_id: "req-1", model: "Claude Opus", start: metric(1) }),
        makeCall({ call_id: "m2", source_request_id: "req-2", model: "gpt-4", start: metric(3) }),
      ],
      execution_events: [
        makeExecutionEvent({
          event_id: "tool-start:one",
          kind: "tool_start",
          subject_node_id: "subject",
          start: metric(2),
        }),
      ],
    });
    const root = makeNode({ node_id: "root", children: [makeNode({ node_id: "subject", topic: "Read settings" })] });
    const bundles = executionBundles(node);
    const bySubject = searchExecutionBundles(bundles, "READ SETTINGS", "chronological", root);
    expect(bySubject.matchCount).toBe(1);
    expect(
      bySubject.bundles.flatMap((bundle) => bundle.entries).map((entry) => [entry.kind, entry.contextOnly]),
    ).toEqual([
      ["call", true],
      ["event", undefined],
    ]);
    expect(searchExecutionBundles(bundles, "missing", "cost")).toEqual({ bundles: [], matchCount: 0 });
    const byModel = searchExecutionBundles(bundles, "CLAUDE OPUS", "cost", root);
    expect(byModel.matchCount).toBe(1);
    expect(byModel.bundles[0].entries.map((entry) => entry.contextOnly)).toEqual([undefined, true]);

    const chronological = searchExecutionBundles(bundles, "CLAUDE OPUS", "chronological", root);
    expect(chronological.matchCount).toBe(1);
    expect(
      chronological.bundles
        .flatMap((bundle) => bundle.entries)
        .map((entry) => [entry.kind === "event" ? entry.event.event_id : entry.call.call_id, entry.contextOnly]),
    ).toEqual([
      ["m1", undefined],
      ["tool-start:one", true],
    ]);
  });

  it("orders chronological search bundles by the earliest displayed sequence entry", () => {
    const owner = makeNode({
      node_id: "owner",
      llm_calls: [makeCall({ call_id: "later-call", model: "shared model", start: metric(50) })],
      execution_events: [makeExecutionEvent({ event_id: "shared-early-event", start: metric(10) })],
    });
    const result = searchExecutionBundles(executionBundles(owner), "shared", "chronological");
    expect(result.matchCount).toBe(2);
    expect(
      result.bundles.map((bundle) =>
        bundle.entries.map((entry) => (entry.kind === "event" ? entry.event.event_id : entry.call.call_id)),
      ),
    ).toEqual([["shared-early-event"], ["later-call"]]);
  });

  it("stops compact chronological context when event times cross known and unknown", () => {
    const owner = makeNode({
      node_id: "owner",
      llm_calls: [makeCall({ call_id: "matched", model: "needle", start: metric(10) })],
      execution_events: [
        makeExecutionEvent({ event_id: "known-following", start: metric(11) }),
        makeExecutionEvent({ event_id: "unknown-following", start: metric(null) }),
      ],
    });
    const result = searchExecutionBundles(executionBundles(owner), "needle", "chronological");
    expect(
      result.bundles
        .flatMap((bundle) => bundle.entries)
        .map((entry) => (entry.kind === "event" ? entry.event.event_id : entry.call.call_id)),
    ).toEqual(["matched", "known-following"]);
  });

  it("keeps a following event in chronological context while its recorded requester stays attached to another call", () => {
    const owner = makeNode({
      node_id: "owner",
      llm_calls: [
        makeCall({ call_id: "requester", source_request_id: "req-a", start: metric(10) }),
        makeCall({ call_id: "matched", model: "needle", source_request_id: "req-b", start: metric(20) }),
      ],
      execution_events: [
        makeExecutionEvent({
          event_id: "late-result",
          kind: "tool_result",
          start: metric(30),
          links: [
            {
              owner_id: "owner",
              source_request_id: "req-a",
              relation: "requested_by",
              evidence: "recorded",
            },
          ],
        }),
      ],
    });

    const bundles = executionBundles(owner);
    expect(
      bundles
        .find((bundle) => bundle.call?.call.call_id === "requester")
        ?.entries.map((entry) => (entry.kind === "event" ? entry.event.event_id : entry.call.call_id)),
    ).toEqual(["requester", "late-result"]);
    expect(bundles.find((bundle) => bundle.call?.call.call_id === "matched")?.entries).toHaveLength(1);

    const searched = searchExecutionBundles(bundles, "needle", "chronological");
    expect(
      searched.bundles
        .flatMap((bundle) => bundle.entries)
        .map((entry) => [entry.kind === "event" ? entry.event.event_id : entry.call.call_id, entry.contextOnly]),
    ).toEqual([
      ["matched", undefined],
      ["late-result", true],
    ]);
  });
});

describe("execution group metrics", () => {
  const fourEvents = (fixture.execution_events ?? []).slice(0, 4);

  it("counts native invocations once and measures elapsed and accumulated durations", () => {
    expect(executionGroupMetrics(fourEvents)).toMatchObject({
      executionCount: 2,
      eventCount: 4,
      elapsedMs: 3000,
      accumulatedMs: 5000,
      elapsedComplete: true,
      accumulatedComplete: true,
    });
  });

  it("does not merge repeated subjects across invocation IDs and treats conflicting snapshots as unavailable", () => {
    const events = [
      makeExecutionEvent({
        event_id: "tool-start:a",
        subject_node_id: "agent",
        execution_start: metric(10),
        execution_end: metric(20),
      }),
      makeExecutionEvent({
        event_id: "tool-start:b",
        subject_node_id: "agent",
        execution_start: metric(30),
        execution_end: metric(50),
      }),
      makeExecutionEvent({
        event_id: "tool-result:a",
        kind: "tool_result",
        subject_node_id: "agent",
        execution_start: metric(11),
        execution_end: metric(20),
      }),
    ];
    expect(executionGroupMetrics(events)).toMatchObject({
      executionCount: 2,
      eventCount: 3,
      elapsedMs: null,
      accumulatedMs: 20,
      elapsedComplete: false,
      accumulatedComplete: false,
    });
  });

  it("reports partial durations and counts metadata without treating it as execution", () => {
    const events: ExecutionEventOut[] = [
      makeExecutionEvent({ event_id: "tool-start:x", execution_start: metric(10), execution_end: metric(null) }),
      makeExecutionEvent({ event_id: "resume:1", kind: "resume", start: metric(15) }),
      makeExecutionEvent({ event_id: "compaction:1", kind: "compaction", start: metric(20) }),
    ];
    expect(executionGroupMetrics(events)).toEqual({
      executionCount: 1,
      eventCount: 3,
      elapsedMs: null,
      accumulatedMs: 0,
      elapsedComplete: false,
      accumulatedComplete: false,
    });
    expect(executionGroupMetrics([])).toEqual({
      executionCount: 0,
      eventCount: 0,
      elapsedMs: 0,
      accumulatedMs: 0,
      elapsedComplete: true,
      accumulatedComplete: true,
    });
  });

  it("counts identity-less records separately and ignores negative duration snapshots", () => {
    const events = [
      makeExecutionEvent({
        event_id: null,
        subject_node_id: null,
        execution_start: metric(20),
        execution_end: metric(10),
      }),
      makeExecutionEvent({
        event_id: null,
        subject_node_id: null,
        execution_start: metric(1),
        execution_end: metric(5),
      }),
    ];
    expect(executionGroupMetrics(events)).toMatchObject({
      executionCount: 2,
      eventCount: 2,
      elapsedMs: null,
      accumulatedMs: 4,
      elapsedComplete: false,
      accumulatedComplete: false,
    });
  });
});
