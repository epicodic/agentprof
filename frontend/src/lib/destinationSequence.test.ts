// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "vitest";
import { makeNode } from "../test/factories";
import { destinationSequenceKey } from "./destinationSequence";

const turn = makeNode({ node_id: "u1", kind: "turn" });
const agent = makeNode({ node_id: "a2", kind: "agent" });
const root = makeNode({ node_id: "s", kind: "session", children: [turn, agent] });
const call = (ownerId: string) => ({ kind: "call" as const, sessionId: "x", ownerId, callKey: "id:c" });
const event = (ownerId: string) => ({ kind: "event" as const, sessionId: "x", ownerId, eventId: "e1" });

test("content destinations and node refs reset nothing", () => {
  expect(destinationSequenceKey(root, call("u1"), "open", "content", false, null)).toBeNull();
  expect(
    destinationSequenceKey(root, { kind: "node", sessionId: "x", nodeId: "u1" }, "open", null, true, null),
  ).toBeNull();
  expect(destinationSequenceKey(root, call("u1"), "open", "workflow", true, null)).toBeNull(); // a call that will be expanded
  expect(destinationSequenceKey(root, call("missing"), "open", "workflow", false, null)).toBeNull();
});

test("an event resets its table even when calls are expanded", () => {
  expect(destinationSequenceKey(root, event("u1"), "open", "workflow", true, null)).toBe("sequence:u1:calls");
  expect(destinationSequenceKey(root, call("u1"), "open", "workflow", undefined, null)).toBeNull();
});

test.each([
  ["open on the owner", call("u1"), "open", "workflow", null, "sequence:u1:calls"],
  ["open on the session", call("s"), "open", "workflow", null, "sequence:s:calls-root"],
  ["reveal on the inspected owner", call("a2"), "reveal", "workflow", "a2", "sequence:a2:calls"],
  ["reveal on the inspected session", call("s"), "reveal", "workflow", "s", "sequence:s:calls-root"],
  ["reveal to the session from another node", call("s"), "reveal", "calls", "a2", "sequence:s:calls-root"],
  [
    "reveal from the session, turn owner, workflow tab",
    call("u1"),
    "reveal",
    "workflow",
    "s",
    "sequence:u1:s:workflow:turn",
  ],
  [
    "reveal from the session, turn owner, calls tab",
    call("u1"),
    "reveal",
    "calls",
    "s",
    "sequence:u1:s:calls:call-turn",
  ],
  ["reveal from the session, agent owner", call("a2"), "reveal", "calls", "s", "sequence:a2:s:calls:sub-agent"],
  ["reveal from another node, turn owner", call("u1"), "reveal", null, "a2", "sequence:u1:a2:calls:turn"],
  [
    "reveal from another node, agent owner",
    call("a2"),
    "reveal",
    "workflow",
    "u1",
    "sequence:a2:u1:workflow:sub-agent",
  ],
  ["reveal with no inspected node", call("u1"), "reveal", "workflow", null, "sequence:u1:null:workflow:turn"],
  [
    "reveal from a node that is not in the tree",
    call("a2"),
    "reveal",
    null,
    "gone",
    "sequence:a2:gone:calls:sub-agent",
  ],
] as const)("%s", (_, ref, reason, tab, inspected, expected) => {
  expect(destinationSequenceKey(root, ref, reason, tab, false, inspected)).toBe(expected);
});
