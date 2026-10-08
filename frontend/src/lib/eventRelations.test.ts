// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import type { EventCallLinkOut } from "../api/types";
import { makeCall, makeNode, metric } from "../test/factories";
import { linkedCallRef } from "./eventRelations";

const link = (owner_id: string | null, source_request_id: string | null): EventCallLinkOut =>
  ({
    owner_id,
    source_request_id,
    relation: "requested_by",
    evidence: "recorded",
  }) as EventCallLinkOut;

describe("linkedCallRef", () => {
  it("resolves one source request through the existing stable call identity", () => {
    const call = makeCall({ call_id: "native", source_request_id: "req" });
    const root = makeNode({ node_id: "root", llm_calls: [call] });
    expect(linkedCallRef(root, "s", link("root", "req"))).toEqual({
      kind: "call",
      sessionId: "s",
      ownerId: "root",
      callKey: "id:native",
    });
  });

  it("rejects duplicate source requests, missing owners and ambiguous matches", () => {
    const duplicate = makeNode({
      node_id: "owner",
      llm_calls: [
        makeCall({ call_id: "a", source_request_id: "req" }),
        makeCall({ call_id: "b", source_request_id: "req" }),
      ],
    });
    const uniqueUnaddressable = makeNode({
      node_id: "owner",
      llm_calls: [makeCall({ source_request_id: "req", start: metric(null) })],
    });
    expect(linkedCallRef(duplicate, "s", link("owner", "req"))).toBeNull();
    expect(linkedCallRef(uniqueUnaddressable, "s", link("owner", "req"))).toBeNull();
    expect(linkedCallRef(duplicate, "s", link(null, "req"))).toBeNull();
    expect(linkedCallRef(duplicate, "s", link("missing", "req"))).toBeNull();
  });

  it("rejects absent or empty request IDs even when a call carries the same value", () => {
    const nullRequest = makeNode({
      node_id: "owner",
      llm_calls: [makeCall({ call_id: "null-id", source_request_id: null })],
    });
    const emptyRequest = makeNode({
      node_id: "owner",
      llm_calls: [makeCall({ call_id: "empty-id", source_request_id: "" })],
    });
    expect(linkedCallRef(nullRequest, "s", link("owner", null))).toBeNull();
    expect(linkedCallRef(emptyRequest, "s", link("owner", ""))).toBeNull();
  });
});
