// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { NodeDetailOut, SessionOut, SummaryOut } from "./types";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail = body !== null && typeof body === "object" && "detail" in body ? body.detail : null;
    throw new Error(typeof detail === "string" ? detail : `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export const queryKeys = {
  sessions: ["sessions"] as const,
  session: (sessionId: string) => ["session", sessionId] as const,
  // Intentionally a prefix of queryKeys.node(...), so invalidating this key invalidates all
  // node details cached for the session.
  nodes: (sessionId: string) => ["node", sessionId] as const,
  node: (sessionId: string, nodeId: string) => ["node", sessionId, nodeId] as const,
};

export function fetchSessions(): Promise<SummaryOut[]> {
  return getJson("/api/sessions");
}

export function fetchSession(sessionId: string): Promise<SessionOut> {
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export function fetchNode(sessionId: string, nodeId: string): Promise<NodeDetailOut> {
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/nodes/${encodeURIComponent(nodeId)}`);
}
