// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { useQuery } from "@tanstack/react-query";
import {
  fetchNode,
  fetchSession,
  fetchSessions,
  fetchTranscript,
  fetchTranscriptEntry,
  fetchTranscriptSearch,
  queryKeys,
  type TranscriptPageOptions,
  type TranscriptSearchOptions,
} from "./client";

export function useSessions() {
  return useQuery({ queryKey: queryKeys.sessions, queryFn: fetchSessions });
}

export function useSession(sessionId: string) {
  return useQuery({ queryKey: queryKeys.session(sessionId), queryFn: () => fetchSession(sessionId) });
}

export function useNode(sessionId: string, nodeId: string | null) {
  return useQuery({
    queryKey: queryKeys.node(sessionId, nodeId ?? ""),
    queryFn: () => fetchNode(sessionId, nodeId ?? ""),
    enabled: nodeId !== null,
  });
}

export function useTranscriptPage(sessionId: string, options: TranscriptPageOptions, active: boolean) {
  return useQuery({
    queryKey: queryKeys.transcriptPage(sessionId, options),
    queryFn: () => fetchTranscript(sessionId, options),
    enabled: active,
    placeholderData: (previousData, previousQuery) => {
      const previousOptions = previousQuery?.queryKey[3];
      if (
        previousData !== undefined &&
        previousQuery?.queryKey[0] === "transcript" &&
        previousQuery.queryKey[1] === sessionId &&
        previousQuery.queryKey[2] === "page" &&
        typeof previousOptions === "object" &&
        previousOptions !== null &&
        (previousOptions.nodeId ?? undefined) === (options.nodeId ?? undefined) &&
        (previousOptions.limit ?? undefined) === (options.limit ?? undefined) &&
        (previousOptions.callKey ?? undefined) === ("callKey" in options ? options.callKey : undefined) &&
        (previousOptions.eventId ?? undefined) === ("eventId" in options ? options.eventId : undefined)
      )
        return previousData;
      return undefined;
    },
  });
}

export function useTranscriptSearch(sessionId: string, options: TranscriptSearchOptions, active: boolean) {
  return useQuery({
    queryKey: queryKeys.transcriptSearch(sessionId, options),
    queryFn: () => fetchTranscriptSearch(sessionId, options),
    enabled: active && options.q.length > 0,
    placeholderData: (previousData, previousQuery) => {
      const previousOptions = previousQuery?.queryKey[3];
      if (
        previousData !== undefined &&
        previousQuery?.queryKey[0] === "transcript" &&
        previousQuery.queryKey[1] === sessionId &&
        previousQuery.queryKey[2] === "search" &&
        typeof previousOptions === "object" &&
        previousOptions !== null &&
        "q" in previousOptions &&
        previousOptions.q === options.q &&
        (previousOptions.nodeId ?? undefined) === (options.nodeId ?? undefined) &&
        (previousOptions.limit ?? undefined) === (options.limit ?? undefined)
      )
        return previousData;
      return undefined;
    },
  });
}

export function useTranscriptEntry(sessionId: string, entryId: string, disclosed: boolean) {
  return useQuery({
    queryKey: queryKeys.transcriptEntry(sessionId, entryId),
    queryFn: () => fetchTranscriptEntry(sessionId, entryId),
    enabled: disclosed && entryId.length > 0,
  });
}
