// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "vitest";
import { cost, makeCall, makeExecutionEvent, makeNode, metric, tokens } from "../test/factories";
import { agentSummaryRows } from "./agentSummary";
import { buildWorkflowIndex } from "./workflowScope";

test("groups turns by agent id and sums duration, own cost and own tokens", () => {
  const root = makeNode({
    node_id: "session",
    kind: "session",
    agent_id: 1,
    children: [
      makeNode({
        node_id: "u1",
        kind: "turn",
        agent_id: 1,
        duration: metric(1000),
        cost_own: cost(0.5, "USD"),
        tokens: tokens(100, 20),
      }),
      makeNode({
        node_id: "u2",
        kind: "turn",
        agent_id: 1,
        duration: metric(2000),
        cost_own: cost(0.25, "USD"),
        tokens: tokens(50, 10),
      }),
    ],
  });

  const rows = agentSummaryRows(root);

  expect(rows).toEqual([
    {
      agentId: 1,
      topic: "session",
      activity: null,
      active: false,
      model: null,
      duration: { value: 3000, provenance: "exact" },
      cost: { value: 0.75, unit: "USD", usd: 0.75, provenance: "exact" },
      costPercent: 100,
      tokensTotal: { value: 180, provenance: "exact" },
      tokensInput: { value: 150, provenance: "exact" },
      tokensOutput: { value: 30, provenance: "exact" },
      cacheTtl: "unknown",
      resumeCount: 0,
    },
  ]);
});

test("uses the latest resumed owner for task state without changing complete-agent totals", () => {
  const earlier = makeNode({
    node_id: "agent-old",
    kind: "agent",
    agent_id: 2,
    topic: "Earlier task",
    activity: "waiting",
    cost_own: cost(2, "USD"),
    tokens: tokens(10, 3),
    execution_events: [
      makeExecutionEvent({
        kind: "completion",
        event_id: "done-old",
        start: metric(90),
        source_stream_id: "old-stream",
        source_order: 4,
      }),
    ],
    llm_calls: [
      { ...makeCall({ call_id: "old", start: metric(100), source_stream_id: "old-stream", source_order: 5 }) },
    ],
  });
  const later = makeNode({
    node_id: "agent-new",
    kind: "agent",
    agent_id: 2,
    topic: "Latest task",
    activity: "running",
    cost_own: cost(3, "USD"),
    tokens: tokens(20, 7),
    llm_calls: [makeCall({ call_id: "new", start: metric(200), source_stream_id: "new-stream", source_order: 1 })],
  });
  const root = makeNode({ node_id: "session", kind: "session", children: [earlier, later] });

  const summary = agentSummaryRows(root).find((row) => row.agentId === 2);
  expect(summary).toMatchObject({
    topic: "Earlier task",
    activity: "waiting",
    cost: { value: 5, usd: 5 },
    tokensInput: { value: 30 },
    tokensOutput: { value: 10 },
  });
  expect(buildWorkflowIndex(root).agentObservations.get(2)).toMatchObject({
    status: "running",
    taskOwnerId: "agent-new",
    completionRecorded: true,
  });

  earlier.llm_calls[0].start = metric();
  later.llm_calls[0].start = metric();
  const ambiguous = buildWorkflowIndex(root).agentObservations.get(2);
  expect(ambiguous).toMatchObject({ status: "unknown", taskOwnerId: null, latest: null, completionRecorded: true });
  expect(agentSummaryRows(root).find((row) => row.agentId === 2)).toMatchObject({
    cost: { value: 5, usd: 5 },
    tokensInput: { value: 30 },
    tokensOutput: { value: 10 },
  });
});

test("sorts rows by agent id and includes an agent nested under a tool call", () => {
  const root = makeNode({
    node_id: "session",
    kind: "session",
    agent_id: 1,
    children: [
      makeNode({
        node_id: "u1",
        kind: "turn",
        agent_id: 1,
        duration: metric(1000),
        children: [
          makeNode({
            node_id: "toolu_agent1",
            kind: "tool",
            agent_id: 1,
            children: [makeNode({ node_id: "a1", kind: "agent", agent_id: 2, duration: metric(500) })],
          }),
        ],
      }),
    ],
  });

  const rows = agentSummaryRows(root);

  expect(rows.map((row) => row.agentId)).toEqual([1, 2]);
  expect(rows[1].duration.value).toBe(500);
});

test("downgrades provenance to estimated when a contributing value is estimated or missing, and n/a when nothing is known", () => {
  const root = makeNode({
    node_id: "session",
    kind: "session",
    children: [
      makeNode({ node_id: "u1", kind: "turn", agent_id: 1, duration: metric(1000, "estimated") }),
      makeNode({ node_id: "u2", kind: "turn", agent_id: 1, duration: metric(2000) }),
      makeNode({ node_id: "u3", kind: "turn", agent_id: 1, duration: metric() }),
      makeNode({ node_id: "u4", kind: "turn", agent_id: 3, duration: metric() }),
    ],
  });

  const rows = agentSummaryRows(root);

  expect(rows[0]).toMatchObject({ agentId: 1, duration: { value: 3000, provenance: "estimated" } });
  expect(rows[1]).toMatchObject({ agentId: 3, duration: { value: null, provenance: "n/a" } });
});

test("ignores tool nodes and nodes without an agent id", () => {
  const root = makeNode({
    node_id: "session",
    kind: "session",
    agent_id: null,
    children: [
      makeNode({ node_id: "t1", kind: "tool", agent_id: 1, duration: metric(1000) }),
      makeNode({ node_id: "u1", kind: "turn", agent_id: null, duration: metric(1000) }),
    ],
  });

  expect(agentSummaryRows(root)).toEqual([]);
});

test("collects an agent's distinct models, sorted and comma-joined", () => {
  const root = makeNode({
    node_id: "session",
    kind: "session",
    children: [
      makeNode({ node_id: "u1", kind: "turn", agent_id: 1, model: "gpt-5" }),
      makeNode({ node_id: "u2", kind: "turn", agent_id: 1, model: "claude-sonnet-4" }),
      makeNode({ node_id: "u3", kind: "turn", agent_id: 1, model: "gpt-5" }),
      makeNode({ node_id: "u4", kind: "turn", agent_id: 2, model: null }),
    ],
  });

  const rows = agentSummaryRows(root);

  expect(rows[0]).toMatchObject({ agentId: 1, model: "claude-sonnet-4, gpt-5" });
  expect(rows[1]).toMatchObject({ agentId: 2, model: null });
});

test("counts linked resumes and labels cache TTL only when every write has a known split", () => {
  const root = makeNode({
    node_id: "session",
    kind: "session",
    children: [
      makeNode({
        node_id: "agent-a",
        kind: "agent",
        agent_id: 2,
        resume_times: [metric(1000), metric(2000)],
        llm_calls: [
          {
            call_id: "call",
            start: metric(10),
            duration: metric(10),
            model: "claude",
            tokens: { ...tokens(), cache_write: metric(20), cache_write_5m: metric(20), cache_write_1h: metric(0) },
            cost: cost(),
            in_context: true,
            cost_parts: {},
            price_prefix: null,
            gap: metric(),
            gap_basis: null,
            preceding_events: [],
            cold_reason: "unknown",
            cold_rewrite: false,
            source_request_id: null,
            source_order: null,
            source_stream_id: null,
            timing_basis: "unknown",
          },
        ],
      }),
    ],
  });

  expect(agentSummaryRows(root)[0]).toMatchObject({ agentId: 2, resumeCount: 2, cacheTtl: "5m" });
});

test("drops bracketed placeholder models once there is more than one distinct model", () => {
  const root = makeNode({
    node_id: "session",
    kind: "session",
    children: [
      makeNode({ node_id: "u1", kind: "turn", agent_id: 1, model: "gpt-5" }),
      makeNode({ node_id: "u2", kind: "turn", agent_id: 1, model: "<synthetic>" }),
      makeNode({ node_id: "u3", kind: "turn", agent_id: 2, model: "<synthetic>" }),
      makeNode({ node_id: "u4", kind: "turn", agent_id: 3, model: "<synthetic>" }),
      makeNode({ node_id: "u5", kind: "turn", agent_id: 3, model: "<compact>" }),
    ],
  });

  const rows = agentSummaryRows(root);

  expect(rows[0]).toMatchObject({ agentId: 1, model: "gpt-5" });
  expect(rows[1]).toMatchObject({ agentId: 2, model: "<synthetic>" });
  expect(rows[2]).toMatchObject({ agentId: 3, model: null });
});

test("computes each row's cost as a percentage of the total cost across all agents", () => {
  const root = makeNode({
    node_id: "session",
    kind: "session",
    children: [
      makeNode({ node_id: "u1", kind: "turn", agent_id: 1, cost_own: cost(0.75, "USD") }),
      makeNode({ node_id: "u2", kind: "turn", agent_id: 2, cost_own: cost(0.25, "USD") }),
    ],
  });

  const rows = agentSummaryRows(root);

  expect(rows[0]).toMatchObject({ agentId: 1, costPercent: 75 });
  expect(rows[1]).toMatchObject({ agentId: 2, costPercent: 25 });
});

test("leaves cost percentage null when no cost is known for any agent", () => {
  const root = makeNode({
    node_id: "session",
    kind: "session",
    children: [makeNode({ node_id: "u1", kind: "turn", agent_id: 1 })],
  });

  const rows = agentSummaryRows(root);

  expect(rows[0].costPercent).toBeNull();
});

test("uses session and agent topics with their tree activity state", () => {
  const root = makeNode({
    node_id: "session",
    kind: "session",
    topic: "Session title",
    agent_id: 1,
    active_descendant: true,
    children: [
      makeNode({
        node_id: "u1",
        kind: "turn",
        agent_id: 1,
        topic: "First prompt",
        active_descendant: true,
        activity: "waiting",
      }),
      makeNode({
        node_id: "a2",
        kind: "agent",
        agent_id: 2,
        topic: "Review parser",
        active: true,
        activity: "running",
      }),
      makeNode({ node_id: "a3", kind: "agent", agent_id: 3, topic: "Completed task" }),
    ],
  });

  expect(
    agentSummaryRows(root).map(({ agentId, topic, activity, active }) => ({ agentId, topic, activity, active })),
  ).toEqual([
    { agentId: 1, topic: "Session title", activity: "waiting", active: true },
    { agentId: 2, topic: "Review parser", activity: "running", active: true },
    { agentId: 3, topic: "Completed task", activity: null, active: false },
  ]);
});
