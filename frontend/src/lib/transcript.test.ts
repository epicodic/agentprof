// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { makeNode } from "../test/factories";
import {
  createTranscriptParticipantLabeler,
  transcriptAvailabilityLabel,
  transcriptMessageText,
  transcriptRef,
  transcriptScopeLabel,
} from "./transcript";

describe("transcript helpers", () => {
  it("constructs stable owner-aware transcript identity", () => {
    expect(transcriptRef("s", "owner", "entry")).toEqual({
      kind: "transcript",
      sessionId: "s",
      ownerId: "owner",
      entryId: "entry",
    });
  });

  it("labels transcript scope by owner and invocation", () => {
    expect(transcriptScopeLabel(null)).toBe("Whole session");
    expect(transcriptScopeLabel(makeNode({ node_id: "root", kind: "session" }))).toBe("Current agent");
    expect(transcriptScopeLabel(makeNode({ node_id: "turn", kind: "turn" }))).toBe("Current turn");
    expect(transcriptScopeLabel(makeNode({ node_id: "agent", kind: "agent" }))).toBe("Current agent");
    expect(transcriptScopeLabel(makeNode({ node_id: "owner", kind: "agent" }), true)).toBe("This invocation");
    expect(transcriptScopeLabel(makeNode({ node_id: "tool", kind: "tool" }))).toBe("This invocation");
  });

  it("reports recorded empty and unavailable transcript content honestly", () => {
    expect(transcriptAvailabilityLabel([])).toBe("Recorded empty");
    expect(transcriptAvailabilityLabel(["unavailable"])).toBe("Unavailable");
    expect(transcriptAvailabilityLabel(["encrypted"])).toBe("Encrypted");
    expect(transcriptAvailabilityLabel(["unsupported"])).toBe("Unsupported");
    expect(transcriptAvailabilityLabel(["truncated"])).toBe("Truncated");
    expect(transcriptAvailabilityLabel(["recorded"])).toBe("Recorded");
  });

  it("labels incoming messages between the owning and calling agents", () => {
    const grandchild = makeNode({ node_id: "grandchild", kind: "agent", agent_id: 3 });
    const child = makeNode({ node_id: "child", kind: "agent", agent_id: 2, children: [grandchild] });
    const turn = makeNode({ node_id: "turn", kind: "turn", agent_id: 1, children: [child] });
    const root = makeNode({ node_id: "root", kind: "session", children: [turn] });
    const label = createTranscriptParticipantLabeler(root);

    expect(label({ owner_id: "child", kind: "user_message", role: "user", ownership_evidence: "recorded" })).toBe(
      "Agent 1 → Agent 2",
    );
    expect(label({ owner_id: "grandchild", kind: "user_message", role: "user", ownership_evidence: "recorded" })).toBe(
      "Agent 2 → Agent 3",
    );
  });

  it("uses recorded addresses, distinguishes tool results, and avoids raw roles", () => {
    const child = makeNode({ node_id: "child", kind: "agent", agent_id: 2, harness_agent_id: "claude-worker" });
    const turn = makeNode({ node_id: "turn", kind: "turn", agent_id: 1, children: [child] });
    const root = makeNode({ node_id: "root", kind: "session", children: [turn] });
    const label = createTranscriptParticipantLabeler(root);

    expect(label({ owner_id: "child", kind: "user_message", role: "user", sender: "turn" })).toBe("Agent 1 → Agent 2");
    expect(
      label({
        owner_id: "child",
        kind: "message",
        role: "assistant",
        sender: "claude-worker",
        recipient: "turn",
      }),
    ).toBe("Agent 2 → Agent 1");
    expect(label({ owner_id: "child", kind: "message", role: "assistant", sender: "Ada", recipient: "Lin" })).toBe(
      "Ada → Lin",
    );
    expect(label({ owner_id: "child", kind: "tool_result", role: "user" })).toBe("Tool result → Agent 2");
    expect(label({ owner_id: "child", kind: "compaction", role: "assistant" })).toBe("Agent 2 Compaction");
    expect(
      label({
        owner_id: "child",
        kind: "tool_request",
        role: "assistant",
        recipient: "claude-worker",
      }),
    ).toBe("Agent 2 → Agent 2");
    expect(label({ owner_id: "child", kind: "message", role: "system", channel: "system" })).toBe("System");
    expect(label({ owner_id: "child", kind: "message", role: "assistant", channel: "request_history_snapshot" })).toBe(
      "Agent 2 Request history",
    );
    expect(label({ owner_id: "missing", kind: "assistant_message", role: "assistant" })).toBe(
      "Participant unavailable",
    );
  });

  it("labels only reliably owned root user messages as human prompts", () => {
    const root = makeNode({ node_id: "root", kind: "session" });
    const label = createTranscriptParticipantLabeler(root);
    expect(label({ owner_id: "root", kind: "user_message", role: "user" })).toBe("User → Agent 1");
    expect(label({ owner_id: "root", kind: "user_message", role: "user", ownership_evidence: "recorded" })).toBe(
      "User → Agent 1",
    );
    for (const ownership_evidence of [
      "root",
      "root_fallback",
      "ambiguous",
      "unresolved_turn:missing",
      "unassigned_turn",
    ]) {
      expect(label({ owner_id: "root", kind: "user_message", role: "user", ownership_evidence })).toBe(
        "Incoming message → Agent 1",
      );
    }
    const nested = makeNode({
      node_id: "nested",
      kind: "agent",
      children: [makeNode({ node_id: "nested-turn", kind: "turn", agent_id: 1 })],
    });
    const partialRoot = makeNode({ node_id: "partial-root", kind: "session", children: [nested] });
    expect(
      createTranscriptParticipantLabeler(partialRoot)({
        owner_id: "nested-turn",
        kind: "user_message",
        role: "user",
        ownership_evidence: "recorded",
      }),
    ).toBe("Incoming message → Agent 1");
  });

  it("unwraps only a complete teammate envelope whose sender was recorded", () => {
    expect(
      transcriptMessageText(
        '<teammate-message teammate_id="worker-2" color="blue">\n## Task\n\nDo it.\n</teammate-message>',
        "user_message",
        "worker-2",
      ),
    ).toBe("## Task\n\nDo it.");
    expect(
      transcriptMessageText(
        '<teammate-message color="blue" teammate_id="worker-2">\nTask\n</teammate-message>',
        "user_message",
        "worker-2",
      ),
    ).toBe("Task");
    expect(
      transcriptMessageText(
        ' \n<teammate-message teammate_id="worker-2">Task</teammate-message> \n',
        "user_message",
        "worker-2",
      ),
    ).toBe("Task");
    const quoted = '<teammate-message teammate_id="worker-2">quoted</teammate-message>';
    expect(transcriptMessageText(quoted, "assistant_message", "worker-2")).toBe(quoted);
    expect(transcriptMessageText(quoted, "user_message", "different-worker")).toBe(quoted);
    expect(transcriptMessageText('<teammate-message teammate_id="worker-2">partial', "user_message", "worker-2")).toBe(
      '<teammate-message teammate_id="worker-2">partial',
    );
  });
});
