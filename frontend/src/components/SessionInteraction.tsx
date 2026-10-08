// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import type { NodeOut } from "../api/types";
import type { EntityRef, ResolvedEntity } from "../lib/entities";
import type { DetailTab, InspectionLocation } from "../lib/inspectionLocation";

export interface SessionInteraction {
  sessionId: string;
  root: NodeOut;
  location: InspectionLocation;
  resolved: ResolvedEntity | null;
  unavailable: boolean;
  revealVersion: number;
  revealTarget: string | null;
  restoringHistory: boolean;
  restorationVersion: number;
  inspectionRequest: InspectionRequest | null;
  localMark: { viewKey: string; key: string } | null;
  clipboardError: boolean;
  copyLink: (ref: EntityRef) => void;
  selectEntity: (ref: EntityRef) => void;
  markLocal: (viewKey: string, key: string) => void;
  openEntity: (ref: EntityRef, expandCall?: boolean) => void;
  openNode: (nodeId: string) => void;
  changeTab: (tab: DetailTab) => void;
  closeDetails: () => void;
  clearSelection: () => void;
  saveSnapshot: () => void;
  memory: Map<string, unknown>;
}

export interface InspectionRequest {
  expandCall?: boolean;
  ref: EntityRef;
  version: number;
}

export type FocusRequest =
  | { kind: "call"; ownerId: string; callKey?: string; index: number; version?: number; expand?: boolean }
  | { kind: "event"; ownerId: string; eventId: string; index: number; version?: number };

export function focusRequestToken(request: FocusRequest): string {
  return request.kind === "call"
    ? `call:${request.ownerId}:${request.callKey ?? `index:${request.index}`}:${request.version ?? 0}`
    : `event:${request.ownerId}:${request.eventId}:${request.version ?? 0}`;
}

export const SessionInteractionContext = createContext<SessionInteraction | null>(null);

export function useSessionInteraction(): SessionInteraction | null {
  return useContext(SessionInteractionContext);
}

export function useInspectionMemory<T>(key: string, initial: () => T): [T, (value: T | ((old: T) => T)) => void] {
  const interaction = useSessionInteraction();
  const memory = interaction?.memory;
  const [value, setValue] = useState<T>(() => {
    const saved = memory?.get(key);
    return saved === undefined ? initial() : (saved as T);
  });
  const valueRef = useRef(value);
  const update = useCallback(
    (next: T | ((old: T) => T)) => {
      const value = typeof next === "function" ? (next as (old: T) => T)(valueRef.current) : next;
      valueRef.current = value;
      memory?.set(key, value);
      interaction?.saveSnapshot();
      setValue(value);
    },
    [interaction, key, memory],
  );
  useLayoutEffect(() => {
    if (memory !== undefined && !memory.has(key)) memory.set(key, valueRef.current);
  }, [key, memory]);
  return [value, update];
}

export function usePanelReadingPosition(key: string, active: boolean) {
  const interaction = useSessionInteraction();
  const memory = interaction?.memory;
  const saveSnapshot = interaction?.saveSnapshot;
  const ref = useRef<HTMLDivElement>(null);
  const onScroll = useCallback(() => {
    if (active && ref.current !== null) {
      memory?.set(`scroll:${key}`, ref.current.scrollTop);
      saveSnapshot?.();
    }
  }, [active, key, memory, saveSnapshot]);

  useLayoutEffect(() => {
    if (!active || memory === undefined) return;
    const saved = memory.get(`scroll:${key}`);
    if (typeof saved !== "number") return;
    const frame = window.requestAnimationFrame(() => {
      const panel = ref.current;
      if (panel !== null && panel.getClientRects().length > 0) panel.scrollTop = saved;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, key, memory]);

  return { ref, onScroll };
}
