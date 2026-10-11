// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { makeCall, makeExecutionEvent, makeNode } from "../test/factories";
import { resolveFindingReference } from "./findingReferences";

describe("resolveFindingReference", () => {
  const root = makeNode({
    node_id: "session",
    kind: "session",
    children: [
      makeNode({
        node_id: "owner",
        kind: "turn",
        llm_calls: [makeCall({ call_id: "c1" })],
        execution_events: [makeExecutionEvent({ event_id: "e1" })],
      }),
    ],
  });

  it("retains the referenced owner for calls and events and resolves node keys", () => {
    expect(
      resolveFindingReference(root, "s", { kind: "call", owner_id: "owner", key: "id:c1", label: "call" }),
    ).toEqual({
      kind: "call",
      sessionId: "s",
      ownerId: "owner",
      callKey: "id:c1",
    });
    expect(resolveFindingReference(root, "s", { kind: "event", owner_id: "owner", key: "e1", label: "event" })).toEqual(
      {
        kind: "event",
        sessionId: "s",
        ownerId: "owner",
        eventId: "e1",
      },
    );
    expect(
      resolveFindingReference(root, "s", { kind: "node", owner_id: "owner", key: "owner", label: "node" }),
    ).toEqual({
      kind: "node",
      sessionId: "s",
      nodeId: "owner",
    });
  });

  it("returns null for unresolved or malformed references without selecting a fallback", () => {
    expect(
      resolveFindingReference(root, "s", { kind: "call", owner_id: "missing", key: "id:c1", label: "call" }),
    ).toBeNull();
    expect(
      resolveFindingReference(root, "s", { kind: "call", owner_id: "owner", key: "id:missing", label: "call" }),
    ).toBeNull();
    expect(
      resolveFindingReference(root, "s", { kind: "call", owner_id: "owner", key: "time:01", label: "call" }),
    ).toBeNull();
    expect(
      resolveFindingReference(root, "s", { kind: "event", owner_id: "owner", key: "missing", label: "event" }),
    ).toBeNull();
    expect(
      resolveFindingReference(root, "s", { kind: "node", owner_id: "owner", key: "missing", label: "node" }),
    ).toBeNull();
    expect(
      resolveFindingReference(root, "s", { kind: "node", owner_id: "different-owner", key: "owner", label: "node" }),
    ).toBeNull();
  });
});
