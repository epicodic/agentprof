// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NavigationType } from "react-router";
import { isRestoringHistory } from "../lib/historyRestoration";

/** Remembers the page state of every history entry and restores it on back/forward navigation. */
export function useHistoryRestoration<T>(options: {
  locationKey: string;
  navigationType: NavigationType;
  capture: () => T;
  apply: (snapshot: T) => void;
  onBeforePop: () => void;
}): {
  restoringHistory: boolean;
  restorationVersion: number;
  saveSnapshot: () => void;
  keepReplaceBaseline: () => void;
} {
  const { locationKey, navigationType, capture, apply, onBeforePop } = options;
  const snapshots = useRef(new Map<string, T>());
  const lastLocationKey = useRef(locationKey);
  const pendingReplaceBaseline = useRef<T | null>(null);
  const [restorationPending, setRestorationPending] = useState<string | null>(null);
  const [restorationVersion, setRestorationVersion] = useState(0);
  const restoringHistory = isRestoringHistory({
    pendingKey: restorationPending,
    navigationType,
    key: locationKey,
    lastKey: lastLocationKey.current,
    hasSnapshot: snapshots.current.has(locationKey),
  });
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const saveSnapshot = useCallback(() => {
    snapshots.current.set(locationKey, capture());
  }, [capture, locationKey]);
  const saveSnapshotRef = useRef(saveSnapshot);
  saveSnapshotRef.current = saveSnapshot;

  const keepReplaceBaseline = useCallback(() => {
    if (pendingReplaceBaseline.current === null) {
      pendingReplaceBaseline.current = snapshots.current.get(locationKey) ?? null;
    }
  }, [locationKey]);

  useEffect(() => {
    const saveBeforePop = () => {
      onBeforePop();
      saveSnapshotRef.current();
    };
    window.addEventListener("popstate", saveBeforePop, true);
    return () => window.removeEventListener("popstate", saveBeforePop, true);
  }, [onBeforePop]);

  useLayoutEffect(() => {
    if (restoringHistory) {
      const snapshot = snapshots.current.get(locationKey);
      if (snapshot !== undefined) {
        applyRef.current(snapshot);
        setRestorationPending(locationKey);
        setRestorationVersion((version) => version + 1);
      }
    } else if (navigationType === "REPLACE" && pendingReplaceBaseline.current !== null) {
      snapshots.current.set(locationKey, pendingReplaceBaseline.current);
    }
    pendingReplaceBaseline.current = null;
    lastLocationKey.current = locationKey;
  }, [navigationType, restoringHistory, locationKey]);

  useLayoutEffect(() => {
    if (!restoringHistory) saveSnapshot();
  }, [restoringHistory, saveSnapshot]);

  useEffect(() => {
    if (restorationPending === locationKey && restorationVersion > 0) setRestorationPending(null);
  }, [restorationPending, restorationVersion, locationKey]);

  return { restoringHistory, restorationVersion, saveSnapshot, keepReplaceBaseline };
}
