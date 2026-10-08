// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { makeCall, makeNode, metric } from "../test/factories";
import { ActivityTrack } from "./ActivityTrack";
import type { SessionInteraction } from "./SessionInteraction";
import { SessionInteractionContext } from "./SessionInteraction";

test("marks linked agent resume times on the activity track", () => {
  const node = makeNode({
    node_id: "agent-a",
    kind: "agent",
    start: metric(0),
    end: metric(100),
    resume_times: [metric(50)],
  });

  const html = renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(ActivityTrack, { node, view: { start: 0, end: 100 } })),
  );

  expect(html).toContain('data-testid="track-agent-a"');
  expect(html).toContain('data-testid="resume-mark-agent-a-0"');
  expect(html).toContain("left:50%");
});

test("renders native call hit targets with exact selection by owner and index", () => {
  const firstCall = makeCall({ call_id: "first", start: metric(50), duration: metric(10) });
  const secondCall = makeCall({ call_id: "second", start: metric(50), duration: metric(10) });
  const first = makeNode({ node_id: "turn-a", kind: "turn", llm_calls: [firstCall] });
  const second = makeNode({ node_id: "turn-b", kind: "turn", llm_calls: [secondCall] });
  const node = makeNode({ node_id: "session", kind: "session", children: [first, second] });
  const interaction: SessionInteraction = {
    sessionId: "session-id",
    root: node,
    location: {
      nodeId: null,
      tab: null,
      selection: { kind: "call", sessionId: "session-id", ownerId: "turn-b", callKey: "id:second" },
      invalidSelection: false,
    },
    resolved: { node: second, call: secondCall, event: null, index: 0 },
    unavailable: false,
    revealVersion: 0,
    revealTarget: null,
    restoringHistory: false,
    restorationVersion: 0,
    inspectionRequest: null,
    localMark: null,
    clipboardError: false,
    copyLink: () => undefined,
    selectEntity: () => undefined,
    markLocal: () => undefined,
    openEntity: () => undefined,
    openNode: () => undefined,
    changeTab: () => undefined,
    closeDetails: () => undefined,
    clearSelection: () => undefined,
    saveSnapshot: () => undefined,
    memory: new Map(),
  };

  const html = renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(
        SessionInteractionContext.Provider,
        { value: interaction },
        createElement(ActivityTrack, { node, view: { start: 0, end: 100 } }),
      ),
    ),
  );

  expect(html).toContain('data-testid="timeline-call-turn-a-0"');
  expect(html).toContain('data-selection="none"');
  expect(html).toContain('data-testid="timeline-call-turn-b-0"');
  expect(html.match(/data-testid="timeline-call-turn-b-0"/g)).toHaveLength(1);
  expect(html).toContain('data-testid="timeline-call-turn-b-0" data-selection="exact"');
});

test("labels a singleton activity call as a timeline control", () => {
  const call = makeCall({ call_id: "single", start: metric(50), duration: metric(10) });
  const turn = makeNode({ node_id: "turn-a", kind: "turn", llm_calls: [call] });
  const interaction: SessionInteraction = {
    sessionId: "session-id",
    root: turn,
    location: { nodeId: "turn-a", tab: "workflow", selection: null, invalidSelection: false },
    resolved: null,
    unavailable: false,
    revealVersion: 0,
    revealTarget: null,
    restoringHistory: false,
    restorationVersion: 0,
    inspectionRequest: null,
    localMark: null,
    clipboardError: false,
    copyLink: () => undefined,
    selectEntity: () => undefined,
    markLocal: () => undefined,
    openEntity: () => undefined,
    openNode: () => undefined,
    changeTab: () => undefined,
    closeDetails: () => undefined,
    clearSelection: () => undefined,
    saveSnapshot: () => undefined,
    memory: new Map(),
  };

  const html = renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(
        SessionInteractionContext.Provider,
        { value: interaction },
        createElement(ActivityTrack, { node: turn, view: { start: 0, end: 100 } }),
      ),
    ),
  );

  expect(html).toContain('aria-label="Select timeline LLM call 1"');
});

test("draws an unknown-duration turn call as an owner-preserving session-track tick", () => {
  const call = makeCall({ call_id: "pending", start: metric(50), duration: metric() });
  const turn = makeNode({ node_id: "turn-a", kind: "turn", llm_calls: [call] });
  const session = makeNode({ node_id: "session", kind: "session", children: [turn] });

  const html = renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(ActivityTrack, { node: session, view: { start: 0, end: 100 } })),
  );

  expect(html).toContain('data-testid="timeline-call-tick-turn-a-0"');
  expect(html).toContain("left:50%");
});
