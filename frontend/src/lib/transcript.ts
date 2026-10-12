// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { NodeOut, TranscriptBlockOut, TranscriptEntryOut, TranscriptSearchHitOut } from "../api/types";
import type { TranscriptRef } from "./entities";

export type TranscriptAvailabilityLabel =
  | "Recorded empty"
  | "Recorded"
  | "Unavailable"
  | "Encrypted"
  | "Unsupported"
  | "Truncated"
  | "Partially available";

type ParticipantEntry = Pick<TranscriptEntryOut | TranscriptSearchHitOut, "owner_id" | "kind" | "role"> & {
  sender?: string | null;
  recipient?: string | null;
  channel?: string | null;
  ownership_evidence?: string | null;
};

function agentLabel(agentId: number | null): string | null {
  return agentId === null ? null : `Agent ${agentId}`;
}

export function createTranscriptParticipantLabeler(root: NodeOut): (entry: ParticipantEntry) => string {
  const nodes = new Map<string, NodeOut>();
  const parents = new Map<string, NodeOut>();
  const addresses = new Map<string, NodeOut[]>();
  const visit = (node: NodeOut, parent: NodeOut | null): void => {
    nodes.set(node.node_id, node);
    if (parent !== null) parents.set(node.node_id, parent);
    for (const address of [node.node_id, node.harness_agent_id]) {
      if (address === null) continue;
      const matches = addresses.get(address) ?? [];
      matches.push(node);
      addresses.set(address, matches);
    }
    for (const child of node.children) visit(child, node);
  };
  visit(root, null);

  const ownerAgentId = (owner: NodeOut | undefined): number | null => {
    let current = owner;
    while (current !== undefined) {
      if (current.agent_id !== null) return current.agent_id;
      if (current.kind === "session") return 1;
      current = parents.get(current.node_id);
    }
    return null;
  };
  const recordedAddress = (address: string): string => {
    const matchingNodes = addresses.get(address) ?? [];
    const labels = new Set(matchingNodes.map((node) => agentLabel(ownerAgentId(node))).filter(Boolean));
    if (labels.size === 1) return [...labels][0] as string;
    return address;
  };
  const parentAgentId = (owner: NodeOut | undefined): number | null => {
    if (owner === undefined) return null;
    let current = parents.get(owner.node_id);
    while (current !== undefined) {
      const id = ownerAgentId(current);
      if (id !== null && id !== ownerAgentId(owner)) return id;
      current = parents.get(current.node_id);
    }
    return null;
  };
  const isMainAgentOwner = (owner: NodeOut | undefined): boolean => {
    let current = owner;
    while (current !== undefined) {
      if (current.kind === "agent") return false;
      current = parents.get(current.node_id);
    }
    return owner?.kind === "session" || (owner?.kind === "turn" && owner.agent_id === 1);
  };

  return (entry) => {
    const owner = nodes.get(entry.owner_id);
    const ownerLabel = agentLabel(ownerAgentId(owner));
    if (entry.kind === "tool_result") return `Tool result → ${ownerLabel ?? "Participant unavailable"}`;
    if (entry.kind === "compaction") {
      return ownerLabel === null ? "Agent Compaction" : `${ownerLabel} Compaction`;
    }
    if (entry.channel === "request_history_snapshot") {
      return ownerLabel === null ? "Agent Request history" : `${ownerLabel} Request history`;
    }
    if (entry.role === "system" || entry.channel === "system") return "System";

    const sender = entry.sender?.trim() || null;
    const recipient = entry.recipient?.trim() || null;
    if (sender !== null && recipient !== null) return `${recordedAddress(sender)} → ${recordedAddress(recipient)}`;
    if (sender !== null && entry.role === "user") {
      return `${recordedAddress(sender)} → ${ownerLabel ?? "Participant unavailable"}`;
    }
    if (sender !== null) return recordedAddress(sender);
    if (recipient !== null) return `${ownerLabel ?? "Participant unavailable"} → ${recordedAddress(recipient)}`;

    if (entry.kind === "user_message" && entry.role === "user") {
      const evidence = entry.ownership_evidence?.toLowerCase() ?? "";
      const unreliableOwnership =
        evidence.includes("ambiguous") ||
        evidence.includes("unresolved") ||
        evidence === "unassigned_turn" ||
        evidence === "root" ||
        evidence.includes("fallback");
      if (ownerLabel === "Agent 1" && isMainAgentOwner(owner)) {
        return unreliableOwnership ? "Incoming message → Agent 1" : "User → Agent 1";
      }
      if (unreliableOwnership) return `Incoming message → ${ownerLabel ?? "Participant unavailable"}`;
      const caller = agentLabel(parentAgentId(owner));
      return `${caller ?? "Incoming message"} → ${ownerLabel ?? "Participant unavailable"}`;
    }
    if (entry.kind === "assistant_message" || entry.kind === "reasoning") {
      return ownerLabel ?? "Participant unavailable";
    }
    if (entry.kind === "tool_request") return `${ownerLabel ?? "Participant unavailable"} → Tool`;
    if (entry.kind === "delegation") return ownerLabel ?? "Participant unavailable";
    return ownerLabel ?? "Participant unavailable";
  };
}

export function transcriptMessageText(text: string, kind: string, sender: string | null | undefined): string {
  const recordedSender = sender?.trim();
  if (kind !== "user_message" || !recordedSender) return text;
  const envelope =
    /^\s*<teammate-message((?:\s+[A-Za-z_][\w.-]*="[^"<>]*")+)\s*>([\s\S]*)<\/teammate-message>\s*$/.exec(text);
  if (envelope === null) return text;
  const attributes = [...envelope[1].matchAll(/\s+([A-Za-z_][\w.-]*)="([^"<>]*)"/g)];
  const senderIds = attributes.filter(([, name]) => name === "teammate_id");
  if (senderIds.length !== 1 || senderIds[0]?.[2] !== recordedSender) return text;
  return envelope[2].replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

export function transcriptRef(sessionId: string, ownerId: string, entryId: string): TranscriptRef {
  return { kind: "transcript", sessionId, ownerId, entryId };
}

export function transcriptScopeLabel(owner: NodeOut | null, invocation = false): string {
  if (invocation || owner?.kind === "tool") return "This invocation";
  if (owner === null) return "Whole session";
  if (owner.kind === "turn") return "Current turn";
  // The session root's own stream spans the main agent's turns, excluding descendants.
  return "Current agent";
}

export function transcriptAvailabilityLabel(
  availability: readonly TranscriptBlockOut["availability"][],
): TranscriptAvailabilityLabel {
  if (availability.length === 0) return "Recorded empty";
  const unique = new Set(availability);
  if (unique.size > 1) return "Partially available";
  const value = availability[0];
  if (value === "unavailable") return "Unavailable";
  if (value === "encrypted") return "Encrypted";
  if (value === "unsupported") return "Unsupported";
  if (value === "truncated") return "Truncated";
  return "Recorded";
}
