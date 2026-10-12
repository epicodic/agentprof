// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { queryKeys } from "./client";
import type { SessionOut, SummaryOut } from "./types";

/** The session list after an `updated` event; an unloaded list stays unloaded. */
export function applyUpdate(rows: SummaryOut[] | undefined, row: SummaryOut): SummaryOut[] | undefined {
  if (rows === undefined) return rows;
  return [row, ...rows.filter((existing) => existing.id !== row.id)].sort((a, b) => b.mtime - a.mtime);
}

export function applyRemoval(rows: SummaryOut[] | undefined, sessionId: string): SummaryOut[] | undefined {
  return rows?.filter((row) => row.id !== sessionId);
}

/** Whether a loaded session describes an older file version than the event's row. */
export function isStale(session: SessionOut | undefined, row: SummaryOut): boolean {
  return session !== undefined && row.mtime > session.mtime;
}

/** Invalidate transcript queries while retaining their cached values for refetch error states. */
export function invalidateTranscriptCaches(queryClient: QueryClient, sessionId?: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: queryKeys.transcripts(sessionId) });
}

/** Keep the session list and open sessions current from the server's event stream. */
export function useSessionEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const source = new EventSource("/api/sessions/events");
    const onOpen = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void invalidateTranscriptCaches(queryClient);
    };
    const onUpdated = (event: MessageEvent<string>) => {
      const row = JSON.parse(event.data) as SummaryOut;
      queryClient.setQueryData<SummaryOut[]>(queryKeys.sessions, (rows) => applyUpdate(rows, row));
      void invalidateTranscriptCaches(queryClient, row.id);
      if (isStale(queryClient.getQueryData<SessionOut>(queryKeys.session(row.id)), row)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.session(row.id) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.nodes(row.id) });
      }
    };
    const onRemoved = (event: MessageEvent<string>) => {
      const { id } = JSON.parse(event.data) as { id: string };
      queryClient.setQueryData<SummaryOut[]>(queryKeys.sessions, (rows) => applyRemoval(rows, id));
      void invalidateTranscriptCaches(queryClient, id);
    };
    source.addEventListener("open", onOpen);
    source.addEventListener("updated", onUpdated);
    source.addEventListener("removed", onRemoved);
    return () => source.close();
  }, [queryClient]);
}
