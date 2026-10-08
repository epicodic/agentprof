// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { cost, makeCall, makeExecutionEvent, makeNode, metric } from "../test/factories";
import type { EntityRef } from "./entities";
import {
  agentNode,
  callRef,
  callRefs,
  eventRef,
  eventRefs,
  relationsToNodes,
  relationToNode,
  resolveEntity,
  sameEntity,
} from "./entities";

const callAt = (start: number | null, callId: string | null = null, provenance = "exact") =>
  makeCall({ call_id: callId, start: metric(start, provenance) });

function requiredCallRef(sessionId: string, owner: ReturnType<typeof makeNode>, index: number) {
  const ref = callRef(sessionId, owner, index);
  if (ref === null) throw new Error("expected a call reference");
  return ref;
}

const ownerTree = (calls: ReturnType<typeof makeCall>[], ownerId = "owner") => {
  const owner = makeNode({ node_id: ownerId, kind: "agent", llm_calls: calls });
  const child = makeNode({ node_id: "child", kind: "turn", children: [owner] });
  return makeNode({ node_id: "root", kind: "session", children: [child] });
};

describe("callRef", () => {
  it("uses unique source IDs and otherwise unique exact start timestamps", () => {
    const root = ownerTree([callAt(20, "m:/?"), callAt(10)]);

    expect(callRef("s", root.children[0].children[0], 0)).toEqual({
      kind: "call",
      sessionId: "s",
      ownerId: "owner",
      callKey: "id:m:/?",
    });
    expect(callRef("s", root.children[0].children[0], 1)).toEqual({
      kind: "call",
      sessionId: "s",
      ownerId: "owner",
      callKey: "time:10",
    });
  });

  it("resolves both references to the same calls after reordering and reports new original indexes", () => {
    const root = ownerTree([callAt(20, "native"), callAt(10)]);
    const owner = root.children[0].children[0];
    const sourceCall = owner.llm_calls[0];
    const fallbackCall = owner.llm_calls[1];
    const sourceRef = requiredCallRef("s", owner, 0);
    const fallbackRef = requiredCallRef("s", owner, 1);

    owner.llm_calls.reverse();
    expect(resolveEntity(root, "s", sourceRef)).toEqual({ node: owner, call: sourceCall, event: null, index: 1 });
    expect(resolveEntity(root, "s", fallbackRef)).toEqual({ node: owner, call: fallbackCall, event: null, index: 0 });
  });

  it("rejects duplicate source IDs and duplicate exact timestamps", () => {
    expect(callRef("s", makeNode({ node_id: "o", llm_calls: [callAt(1, "dup"), callAt(2, "dup")] }), 0)).toBeNull();
    expect(callRef("s", makeNode({ node_id: "o", llm_calls: [callAt(1), callAt(1)] }), 0)).toBeNull();
  });

  it("counts native-ID calls when deciding whether a fallback timestamp is unique", () => {
    const owner = makeNode({ node_id: "o", llm_calls: [callAt(1, "native"), callAt(1)] });
    expect(callRef("s", owner, 1)).toBeNull();
  });

  it("does not give fallback identity to unavailable or estimated timestamps", () => {
    const owner = makeNode({
      node_id: "o",
      llm_calls: [callAt(null), callAt(2, null, "estimated"), callAt(Number.NaN), callAt(Number.POSITIVE_INFINITY)],
    });
    expect(owner.llm_calls.map((_, index) => callRef("s", owner, index))).toEqual([null, null, null, null]);
    expect(callRef("s", makeNode({ node_id: "o", llm_calls: [callAt(null, "native")] }), 0)?.callKey).toBe("id:native");
    expect(callRef("s", owner, -1)).toBeNull();
    expect(callRef("s", owner, owner.llm_calls.length)).toBeNull();
  });
});

describe("callRefs", () => {
  it("matches single-call identities while rejecting ambiguous ids and times", () => {
    const node = makeNode({
      node_id: "owner",
      llm_calls: [
        makeCall({ call_id: "unique", start: metric(1, "exact") }),
        makeCall({ call_id: "duplicate", start: metric(2, "exact") }),
        makeCall({ call_id: "duplicate", start: metric(3, "exact") }),
        makeCall({ call_id: null, start: metric(4, "exact") }),
        makeCall({ call_id: null, start: metric(4, "exact") }),
        makeCall({ call_id: null, start: metric(5, "exact") }),
        makeCall({ call_id: "estimated", start: metric(5, "estimated") }),
      ],
    });

    expect(callRefs("session", node)).toEqual([
      callRef("session", node, 0),
      null,
      null,
      null,
      null,
      null,
      callRef("session", node, 6),
    ]);
  });

  it("reads each call a bounded number of times", () => {
    let reads = 0;
    const calls = Array.from({ length: 100 }, (_, index) => {
      const call = makeCall({ call_id: `call-${index}`, start: metric(index, "exact") });
      return call;
    });
    const node = makeNode({ node_id: "owner", llm_calls: calls });
    for (const call of node.llm_calls) {
      const callId = call.call_id;
      const start = call.start;
      Object.defineProperty(call, "call_id", {
        get() {
          reads += 1;
          return callId;
        },
      });
      Object.defineProperty(call, "start", {
        get() {
          reads += 1;
          return start;
        },
      });
    }

    expect(callRefs("session", node)).toHaveLength(calls.length);
    expect(reads).toBeLessThanOrEqual(calls.length * 5);
  });
});

describe("eventRef", () => {
  it("uses unique native event IDs and rejects duplicates and absent IDs", () => {
    const event = makeExecutionEvent({ event_id: "tool-result:t1", kind: "tool_result" });
    const owner = makeNode({ node_id: "u1", execution_events: [event] });
    expect(eventRef("s", owner, 0)).toEqual({
      kind: "event",
      sessionId: "s",
      ownerId: "u1",
      eventId: "tool-result:t1",
    });
    expect(eventRef("s", { ...owner, execution_events: [...(owner.execution_events ?? []), event] }, 0)).toBeNull();
    expect(eventRef("s", makeNode({ node_id: "u2", execution_events: [makeExecutionEvent()] }), 0)).toBeNull();
  });

  it("batches event identities and resolves an event with its source index", () => {
    const owner = makeNode({
      node_id: "u1",
      execution_events: [
        makeExecutionEvent({ event_id: "e1" }),
        makeExecutionEvent(),
        makeExecutionEvent({ event_id: "e2" }),
      ],
    });
    const refs = eventRefs("s", owner);
    expect(refs[0]).toEqual({ kind: "event", sessionId: "s", ownerId: "u1", eventId: "e1" });
    expect(refs[1]).toBeNull();
    const thirdRef = refs[2];
    const firstRef = refs[0];
    if (thirdRef === undefined || thirdRef === null || firstRef === undefined || firstRef === null)
      throw new Error("The addressable event references were not created");
    expect(resolveEntity(owner, "s", thirdRef)).toEqual({
      node: owner,
      call: null,
      event: owner.execution_events?.[2],
      index: 2,
    });
    expect(resolveEntity(owner, "other", firstRef)).toBeNull();
  });
});

describe("entity refs and resolution", () => {
  it("compares all identifying fields and rejects null", () => {
    const a: EntityRef = { kind: "node", sessionId: "s", nodeId: "n" };
    expect(sameEntity(a, { ...a })).toBe(true);
    expect(sameEntity(a, { ...a, sessionId: "other" })).toBe(false);
    expect(sameEntity(a, { kind: "call", sessionId: "s", ownerId: "n", callKey: "id:x" })).toBe(false);
    expect(sameEntity(null, a)).toBe(false);
    expect(sameEntity(a, null)).toBe(false);
    const eventRefValue: EntityRef = { kind: "event", sessionId: "s", ownerId: "n", eventId: "e" };
    expect(sameEntity(eventRefValue, { ...eventRefValue })).toBe(true);
    expect(sameEntity(eventRefValue, { ...eventRefValue, eventId: "other" })).toBe(false);
  });

  it("resolves nodes and calls to their original owner index", () => {
    const root = ownerTree([callAt(20, "native"), callAt(10)]);
    const nodeRef: EntityRef = { kind: "node", sessionId: "s", nodeId: "owner" };
    const call = requiredCallRef("s", root.children[0].children[0], 1);
    expect(resolveEntity(root, "s", nodeRef)).toEqual({
      node: root.children[0].children[0],
      call: null,
      event: null,
      index: null,
    });
    expect(resolveEntity(root, "s", call)).toEqual({
      node: root.children[0].children[0],
      call: root.children[0].children[0].llm_calls[1],
      event: null,
      index: 1,
    });
    expect(resolveEntity(root, "other", call)).toBeNull();
    expect(resolveEntity(root, "s", { ...nodeRef, nodeId: "missing" })).toBeNull();
    expect(resolveEntity(root, "s", { ...call, ownerId: "missing" })).toBeNull();
    expect(resolveEntity(root, "s", { ...call, callKey: "time:99" })).toBeNull();
  });

  it("returns null when a previously stable call becomes ambiguous", () => {
    const owner = makeNode({ node_id: "owner", kind: "agent", llm_calls: [callAt(10)] });
    const ref = requiredCallRef("s", owner, 0);
    const root = ownerTree([owner.llm_calls[0], callAt(10)]);
    expect(resolveEntity(root, "s", ref)).toBeNull();
  });

  it("returns null after the referenced call is removed", () => {
    const root = ownerTree([callAt(10, "native")]);
    const owner = root.children[0].children[0];
    const ref = requiredCallRef("s", owner, 0);
    owner.llm_calls.splice(0, 1);
    expect(resolveEntity(root, "s", ref)).toBeNull();
  });

  it("resolves known and missing source IDs with a bounded linear number of reads", () => {
    const size = 1_000;
    let callIdReads = 0;
    const calls = Array.from({ length: size }, (_, index) => {
      const call = callAt(index, `native-${index}`);
      const callId = call.call_id;
      Object.defineProperty(call, "call_id", {
        get: () => {
          callIdReads += 1;
          return callId;
        },
      });
      return call;
    });
    const root = ownerTree(calls);
    const owner = root.children[0].children[0];
    const knownRef = callRef("s", owner, size - 1);
    expect(knownRef?.kind).toBe("call");
    if (knownRef?.kind !== "call") throw new Error("expected a call reference");
    callIdReads = 0;

    expect(resolveEntity(root, "s", knownRef)?.index).toBe(size - 1);
    expect(resolveEntity(root, "s", { ...knownRef, callKey: "id:missing" })).toBeNull();
    expect(callIdReads).toBeLessThan(20 * size);
  });

  it("keeps a source-ID reference through mutable call resources", () => {
    const call = callAt(10, "native");
    const owner = makeNode({ node_id: "owner", llm_calls: [call] });
    const ref = requiredCallRef("s", owner, 0);
    call.start = metric(30);
    call.duration = metric(99);
    call.model = "new-model";
    call.tokens.input = metric(123);
    call.cost = cost(2, "USD");
    expect(callRef("s", owner, 0)).toEqual(ref);
  });

  it("keeps and resolves a fallback reference through mutable call resources", () => {
    const call = callAt(10);
    const root = ownerTree([call]);
    const owner = root.children[0].children[0];
    const ref = requiredCallRef("s", owner, 0);
    call.duration = metric(99);
    call.model = "new-model";
    call.tokens.input = metric(123);
    call.cost = cost(2, "USD");
    expect(callRef("s", owner, 0)).toEqual(ref);
    expect(resolveEntity(root, "s", ref)).toEqual({ node: owner, call, event: null, index: 0 });
  });
});

describe("relationToNode", () => {
  it("marks only an exact selected node and never marks owners or ancestors for calls", () => {
    const selected = makeNode({ node_id: "selected", kind: "agent", llm_calls: [callAt(1, "selected-call")] });
    const descendant = makeNode({ node_id: "descendant", kind: "agent" });
    const unrelated = makeNode({ node_id: "unrelated", kind: "turn" });
    const root = makeNode({
      node_id: "root",
      kind: "session",
      children: [
        makeNode({ node_id: "turn-a", kind: "turn", children: [selected] }),
        makeNode({ node_id: "turn-b", kind: "turn", children: [unrelated] }),
      ],
    });
    selected.children = [descendant];
    const selectedNode: EntityRef = { kind: "node", sessionId: "s", nodeId: "selected" };
    const selectedCall = requiredCallRef("s", selected, 0);
    expect(relationToNode(root, "s", selectedNode, "selected")).toBe("exact");
    expect(relationToNode(root, "s", selectedNode, "turn-a")).toBe("none");
    expect(relationToNode(root, "s", selectedNode, "descendant")).toBe("none");
    expect(relationToNode(root, "s", selectedCall, "selected")).toBe("none");
    expect(relationToNode(root, "s", selectedCall, "turn-a")).toBe("none");
    expect(relationToNode(root, "s", selectedCall, "descendant")).toBe("none");
    expect(relationToNode(root, "s", selectedNode, "unrelated")).toBe("none");
    expect(relationToNode(root, "other", selectedNode, "selected")).toBe("none");
    expect(relationToNode(root, "s", selectedNode, "missing")).toBe("none");
    expect(relationToNode(root, "s", null, "selected")).toBe("none");
  });
});

describe("relationsToNodes", () => {
  it("marks neither an owner nor ancestors for a selected call", () => {
    const turn = makeNode({
      node_id: "turn",
      kind: "turn",
      llm_calls: [makeCall({ call_id: "request", start: metric(10) })],
    });
    const root = makeNode({ node_id: "session", kind: "session", children: [turn] });
    const ref = requiredCallRef("s", turn, 0);
    expect(relationToNode(root, "s", ref, "turn")).toBe("none");
    expect(relationToNode(root, "s", ref, "session")).toBe("none");
    expect([...relationsToNodes(root, ref, resolveEntity(root, "s", ref))]).toEqual([]);
  });

  it("returns only an exact selected node relation", () => {
    const selected = makeNode({ node_id: "selected", kind: "agent", llm_calls: [callAt(1, "call")] });
    const root = makeNode({
      node_id: "root",
      kind: "session",
      children: [makeNode({ node_id: "turn", kind: "turn", children: [selected] })],
    });
    const ref: EntityRef = { kind: "node", sessionId: "s", nodeId: "selected" };
    const resolved = resolveEntity(root, "s", ref);
    expect(relationsToNodes(root, ref, resolved)).toEqual(new Map([["selected", "exact"]]));
  });

  it("does not mark event owners, subjects, or ancestors", () => {
    const owner = makeNode({
      node_id: "owner",
      kind: "agent",
      execution_events: [makeExecutionEvent({ event_id: "e", subject_node_id: "subject" })],
    });
    const subject = makeNode({ node_id: "subject", kind: "tool" });
    const root = makeNode({
      node_id: "root",
      kind: "session",
      children: [
        makeNode({ node_id: "turn-a", kind: "turn", children: [owner] }),
        makeNode({ node_id: "turn-b", kind: "turn", children: [subject] }),
      ],
    });
    const ref = eventRef("s", owner, 0);
    if (ref === null) throw new Error("Expected an addressable event reference");
    const resolved = resolveEntity(root, "s", ref);
    expect(relationsToNodes(root, ref, resolved)).toEqual(new Map());
  });

  it("does not mark root-owned events when their subject is absent from a projection", () => {
    const root = makeNode({
      node_id: "root",
      kind: "session",
      execution_events: [makeExecutionEvent({ event_id: "root-event", subject_node_id: "omitted-subject" })],
      children: [makeNode({ node_id: "turn", kind: "turn" })],
    });
    const ref = eventRef("s", root, 0);
    if (ref === null) throw new Error("Expected an addressable root event reference");
    const resolved = resolveEntity(root, "s", ref);
    expect(relationsToNodes(root, ref, resolved)).toEqual(new Map());
    expect(relationToNode(root, "s", ref, "turn")).toBe("none");
  });
});

describe("agentNode", () => {
  it("maps Agent 1 to the session root", () => {
    const root = makeNode({ node_id: "root", kind: "session" });
    expect(agentNode(root, 1)).toBe(root);
  });

  it("finds a deeply nested agent by ID and returns null for a missing ID", () => {
    const nested = makeNode({ node_id: "nested", kind: "agent", agent_id: 7 });
    const root = makeNode({
      node_id: "root",
      kind: "session",
      children: [
        makeNode({
          node_id: "turn",
          kind: "turn",
          children: [makeNode({ node_id: "outer", kind: "agent", children: [nested] })],
        }),
      ],
    });
    expect(agentNode(root, 7)).toBe(nested);
    expect(agentNode(root, 99)).toBeNull();
  });
});
