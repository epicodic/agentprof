// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NavigationType } from "react-router";
import { historyEntryKey, isRestoringHistory } from "../lib/historyRestoration";

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

  // Navigations render as deferred transitions, so the browser can be on a newer entry than the rendered one, and callers
  // may hold `saveSnapshot` from an older render. The captured state is always the latest user state, which belongs to
  // the browser's current entry, so snapshots are keyed by that entry and captured from the latest render. After a
  // back/forward navigation, saving pauses until its render commits: until then the state is the entry being left.
  const captureRef = useRef(capture);
  captureRef.current = capture;
  const browserKey = useRef(locationKey);
  const committedKey = useRef(locationKey);
  const popPending = useRef(false);
  useLayoutEffect(() => {
    const current = historyEntryKey(window.history.state);
    browserKey.current = current;
    committedKey.current = locationKey;
    // An intermediate render of a quick double back/forward is not the browser's entry; keep saving paused.
    if (current === locationKey) popPending.current = false;
  }, [locationKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity follows the captured state for the re-save effect
  const saveSnapshot = useCallback(() => {
    if (popPending.current) return;
    const key = historyEntryKey(window.history.state);
    browserKey.current = key;
    snapshots.current.set(key, captureRef.current());
  }, [capture, locationKey]);

  const keepReplaceBaseline = useCallback(() => {
    if (pendingReplaceBaseline.current === null) {
      pendingReplaceBaseline.current = snapshots.current.get(historyEntryKey(window.history.state)) ?? null;
    }
  }, []);

  useEffect(() => {
    // At popstate the browser is already on the target entry; save the state under the entry being left.
    // Returning to the entry that is still rendered (the entry being left never committed) changes no router key, so
    // nothing would restore it: mark it for restoration here.
    const saveBeforePop = () => {
      onBeforePop();
      const leaving = browserKey.current;
      const target = historyEntryKey(window.history.state);
      if (!popPending.current && leaving !== target) {
        snapshots.current.set(leaving, captureRef.current());
      }
      browserKey.current = target;
      if (target !== committedKey.current) {
        popPending.current = true;
        return;
      }
      popPending.current = false;
      // The restore effect below applies the snapshot once this entry is marked as restoring.
      if (snapshots.current.has(target)) setRestorationPending(target);
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
    } else if (
      navigationType === "REPLACE" &&
      pendingReplaceBaseline.current !== null &&
      // A save made after the replace (before this deferred render) already holds the entry's newer state.
      !snapshots.current.has(locationKey)
    ) {
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
