// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { makeCall, makeExecutionEvent, makeNode } from "../test/factories";
import type { EntityRef } from "./entities";
import { detailLink, recordedCallTargets } from "./inspectionActions";

describe("inspection actions", () => {
  it("omits observed consumers and deduplicates recorded requester targets", () => {
    const call = makeCall({ call_id: "call-1", source_request_id: "request-1" });
    const owner = makeNode({ node_id: "turn", kind: "turn", llm_calls: [call] });
    const root = makeNode({ node_id: "root", kind: "session", children: [owner] });
    const events = [
      makeExecutionEvent({
        links: [
          { owner_id: "turn", source_request_id: "request-1", relation: "requested_by", evidence: "recorded" },
          { owner_id: "turn", source_request_id: "request-1", relation: "consumed_by", evidence: "observed_order" },
        ],
      }),
      makeExecutionEvent({
        links: [{ owner_id: "turn", source_request_id: "request-1", relation: "requested_by", evidence: "recorded" }],
      }),
    ];

    expect(recordedCallTargets(root, "s", events, "consumed_by")).toEqual([]);
    expect(recordedCallTargets(root, "s", events, "requested_by")).toEqual([
      { kind: "call", sessionId: "s", ownerId: "turn", callKey: `id:${call.call_id}` },
    ]);
  });

  it("does not choose among duplicate source request IDs", () => {
    const root = makeNode({
      node_id: "turn",
      kind: "turn",
      llm_calls: [makeCall({ source_request_id: "duplicate" }), makeCall({ source_request_id: "duplicate" })],
    });
    const event = makeExecutionEvent({
      links: [{ owner_id: "turn", source_request_id: "duplicate", relation: "requested_by", evidence: "recorded" }],
    });
    expect(recordedCallTargets(root, "s", [event], "requested_by")).toEqual([]);
  });

  it("copies the detail ref while preserving unrelated query parameters", () => {
    const params = new URLSearchParams("filter=slow&tab=workflow&node=root&sel=node&entity=root");
    const ref: EntityRef = { kind: "call", sessionId: "s", ownerId: "turn", callKey: "id:call-1" };
    expect(detailLink("/sessions/s", params, ref)).toBe(
      "/sessions/s?filter=slow&node=turn&tab=workflow&sel=call&owner=turn&call=id%3Acall-1",
    );
    expect(params.toString()).toContain("tab=workflow");
  });
});
