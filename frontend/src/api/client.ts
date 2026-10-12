// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type {
  NodeDetailOut,
  SessionOut,
  SummaryOut,
  TranscriptEntryDetailOut,
  TranscriptPageOut,
  TranscriptSearchOut,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail = body !== null && typeof body === "object" && "detail" in body ? body.detail : null;
    throw new ApiError(
      typeof detail === "string" ? detail : `${response.status} ${response.statusText}`,
      response.status,
    );
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
  transcripts: (sessionId?: string) =>
    sessionId === undefined ? (["transcript"] as const) : (["transcript", sessionId] as const),
  transcriptPage: (sessionId: string, options: TranscriptPageOptions = {}) =>
    [...queryKeys.transcripts(sessionId), "page", normalizeTranscriptPageOptions(options)] as const,
  transcriptSearch: (sessionId: string, options: TranscriptSearchOptions) =>
    [...queryKeys.transcripts(sessionId), "search", normalizeTranscriptSearchOptions(options)] as const,
  transcriptEntry: (sessionId: string, entryId: string) =>
    [...queryKeys.transcripts(sessionId), "entry", entryId] as const,
};

interface TranscriptPageBaseOptions {
  nodeId?: string;
  limit?: number;
}

type TranscriptCursorOptions =
  | { after?: never; anchor?: never }
  | { after: string; anchor?: never }
  | { after?: never; anchor: string };

type TranscriptInvocationOptions =
  | { callKey?: never; eventId?: never }
  | { callKey: string; eventId?: never }
  | { callKey?: never; eventId: string };

export type TranscriptPageOptions = TranscriptPageBaseOptions & TranscriptCursorOptions & TranscriptInvocationOptions;

export interface TranscriptSearchOptions {
  q: string;
  nodeId?: string;
  limit?: number;
  after?: string;
}

function normalizeTranscriptPageOptions(options: TranscriptPageOptions): TranscriptPageOptions {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as TranscriptPageOptions;
}

function normalizeTranscriptSearchOptions(options: TranscriptSearchOptions): TranscriptSearchOptions {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as TranscriptSearchOptions;
}

export function fetchSessions(): Promise<SummaryOut[]> {
  return getJson("/api/sessions");
}

export function fetchSession(sessionId: string): Promise<SessionOut> {
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export function fetchNode(sessionId: string, nodeId: string): Promise<NodeDetailOut> {
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/nodes/${encodeURIComponent(nodeId)}`);
}

export function fetchTranscript(sessionId: string, options: TranscriptPageOptions = {}): Promise<TranscriptPageOut> {
  const params = new URLSearchParams();
  if (options.nodeId !== undefined) params.set("node_id", options.nodeId);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.after !== undefined) params.set("after", options.after);
  if (options.anchor !== undefined) params.set("anchor", options.anchor);
  if ("callKey" in options && options.callKey !== undefined) params.set("call_key", options.callKey);
  if ("eventId" in options && options.eventId !== undefined) params.set("event_id", options.eventId);
  const query = params.size === 0 ? "" : `?${params}`;
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/transcript${query}`);
}

export function fetchTranscriptSearch(
  sessionId: string,
  options: TranscriptSearchOptions,
): Promise<TranscriptSearchOut> {
  const params = new URLSearchParams({ q: options.q });
  if (options.nodeId !== undefined) params.set("node_id", options.nodeId);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.after !== undefined) params.set("after", options.after);
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/transcript/search?${params}`);
}

export function fetchTranscriptEntry(sessionId: string, entryId: string): Promise<TranscriptEntryDetailOut> {
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/transcript/entries/${encodeURIComponent(entryId)}`);
}
