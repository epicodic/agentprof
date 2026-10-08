// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { MantineProvider } from "@mantine/core";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { buildWorkflowIndex } from "../lib/workflowScope";
import { makeCall, makeNode, metric } from "../test/factories";
import { AgentSummaryTable } from "./AgentSummaryTable";

function renderTable(props: ComponentProps<typeof AgentSummaryTable>): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(MantineProvider, null, createElement(AgentSummaryTable, props))),
  );
}

test("renders activity and topic columns with active agent badges", () => {
  const root = makeNode({
    node_id: "session",
    kind: "session",
    agent_id: 1,
    topic: "Session title",
    active_descendant: true,
    children: [
      makeNode({ node_id: "u1", kind: "turn", agent_id: 1, active_descendant: true, activity: "waiting" }),
      makeNode({
        node_id: "a2",
        kind: "agent",
        agent_id: 2,
        topic: "Review parser",
        active: true,
        activity: "running",
        resume_times: [{ value: 1000, provenance: "exact" }],
      }),
      makeNode({ node_id: "a3", kind: "agent", agent_id: 3, topic: "Completed task" }),
    ],
  });

  const html = renderTable({ root, onSelectAgent: () => {} });

  expect(html).toMatch(/<th[^>]*>Agent ▲<\/th>.*<th[^>]*>Activity<\/th>.*<th[^>]*>Topic<\/th>.*<th[^>]*>Model<\/th>/s);
  const row = (agentId: number) =>
    html.match(new RegExp(`data-testid="agent-summary-row-${agentId}"[^]*?<\\/tr>`))?.[0];
  expect(row(1)).toContain('data-workflow-status="waiting"');
  expect(row(1)).toContain(">WAITING</span>");
  expect(row(2)).toContain('data-workflow-status="running"');
  expect(row(2)).toContain(">RUNNING</span>");
  expect(html).toContain("Resumes");
  expect(html).toContain("Cache TTL");
  expect(row(2)).toContain(">1<");
  expect(row(3)).toContain("Completed task");
  expect(row(3)).not.toContain("active");
  expect(row(3)).not.toContain("RUNNING");
  expect(row(3)).not.toContain("WAITING");
});

test("renders representative topic and latest observed activity with complete metrics", () => {
  const oldOwner = makeNode({
    node_id: "old-agent",
    kind: "agent",
    agent_id: 2,
    topic: "Representative task",
    llm_calls: [{ ...makeCall({ call_id: "old-call", start: metric(100) }) }],
  });
  const currentOwner = makeNode({
    node_id: "current-agent",
    kind: "agent",
    agent_id: 2,
    topic: "Current task",
    llm_calls: [makeCall({ call_id: "current-call", start: metric(200) })],
  });
  const root = makeNode({ node_id: "session", kind: "session", children: [oldOwner, currentOwner] });
  const html = renderTable({
    root,
    onSelectAgent: () => {},
    workflowIndex: buildWorkflowIndex(root),
    activityFilter: "all",
    scopeId: null,
    scopeOnly: false,
  });
  const row = html.match(/<tr\b(?=[^>]*data-testid="agent-summary-row-2")[^>]*>.*?<\/tr>/s)?.[0] ?? "";

  expect(html).not.toMatch(/<th[^>]*>Latest task<\/th>/);
  expect(html).toContain("Representative task");
  expect(html).toContain("Latest observed activity");
  expect(row).not.toContain("data-workflow-status");
  expect(row).not.toContain("State unknown");
  expect(html).toContain("Complete-agent totals; session cost share");
});

test("keeps summary counts and an enabled scope switch when no logical agents match", () => {
  const focused = makeNode({ node_id: "focused", kind: "agent", agent_id: 9, topic: "Focused branch" });
  const outside = makeNode({ node_id: "outside", kind: "agent", agent_id: 2, topic: "Outside branch" });
  const root = makeNode({ node_id: "session", kind: "session", children: [focused, outside] });
  const html = renderTable({
    root,
    onSelectAgent: () => {},
    workflowIndex: buildWorkflowIndex(root),
    activityFilter: "running",
    scopeId: "focused",
    scopeOnly: true,
    onScopeOnly: () => {},
    onActivityReset: () => {},
    hierarchyMatchCount: 7,
  });

  expect(html).toContain("Complete-agent totals; session cost share");
  expect(html).toContain("Hierarchy rows matching: 7");
  expect(html).toContain("Logical agents matching: 0");
  expect(html).toContain("No agents match this activity filter");
  expect(html).toContain("Agents in focused subtree");
  expect(html).toContain("Clear activity filter");
  expect(html).not.toContain("disabled");
});

test("shows known timing without inventing an owner when latest activity ordering is ambiguous", () => {
  const first = makeNode({
    node_id: "resume-first",
    kind: "agent",
    agent_id: 2,
    topic: "First resume",
    llm_calls: [makeCall({ call_id: "first-call", start: metric(500), source_stream_id: "first-stream" })],
  });
  const second = makeNode({
    node_id: "resume-second",
    kind: "agent",
    agent_id: 2,
    topic: "Second resume",
    llm_calls: [makeCall({ call_id: "second-call", start: metric(500), source_stream_id: "second-stream" })],
  });
  const root = makeNode({ node_id: "session", kind: "session", children: [first, second] });
  const observation = buildWorkflowIndex(root).agentObservations.get(2);
  const html = renderTable({ root, onSelectAgent: () => {}, workflowIndex: buildWorkflowIndex(root) });
  const knownTime = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(new Date(500));

  expect(observation).toMatchObject({ latest: null, latestTimedAtMs: 500, taskOwnerId: null });
  expect(html).toContain("Latest activity ordering unavailable");
  expect(html).toContain(knownTime);
  expect(html).not.toContain("Activity timing unavailable");
  expect(html).not.toContain("Latest task unavailable");
});
