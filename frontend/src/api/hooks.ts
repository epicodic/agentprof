// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { useQuery } from "@tanstack/react-query";
import { fetchNode, fetchSession, fetchSessions, queryKeys } from "./client";

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
