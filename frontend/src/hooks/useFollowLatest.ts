// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from "react";
import type { NavigationType } from "react-router";
import { followNote as followNoteFor, followOwner } from "../lib/followLatest";
import { newFollowTarget, type WorkflowFollowResult } from "../lib/workflowReading";
import type { ObservedItem } from "../lib/workflowState";

/** Follow-latest mode: reveals the owner of new activity until the user takes control. */
export function useFollowLatest(options: {
  items: readonly ObservedItem[];
  matches: ReadonlySet<string>;
  navigationType: NavigationType;
  onRevealOwner: (ownerId: string) => void;
}): {
  followLatest: boolean;
  followNote: string | null;
  pauseFollow: () => void;
  pauseForUserControl: (event: SyntheticEvent<HTMLElement>) => void;
  setFollowMode: (enabled: boolean) => void;
} {
  const { items, matches, navigationType, onRevealOwner } = options;
  const [followLatest, setFollowLatest] = useState(false);
  const followLatestRef = useRef(false);
  const previousObservations = useRef<readonly ObservedItem[] | null>(null);
  const [followNote, setFollowNote] = useState<string | null>(null);

  const pauseFollow = useCallback(() => {
    followLatestRef.current = false;
    setFollowLatest(false);
    setFollowNote(null);
  }, []);

  const pauseForUserControl = useCallback(
    (event: SyntheticEvent<HTMLElement>) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('[data-testid="follow-latest-toggle"]') !== null) {
        const native = event.nativeEvent;
        const isActivation =
          (native instanceof PointerEvent && native.button === 0) ||
          native instanceof TouchEvent ||
          (native instanceof KeyboardEvent && ["Enter", " "].includes(native.key));
        if (isActivation) return;
      }
      pauseFollow();
    },
    [pauseFollow],
  );

  const acceptFollowResult = useCallback(
    (result: WorkflowFollowResult) => {
      const owner = followOwner(result);
      setFollowNote(followNoteFor(result));
      if (owner !== null) onRevealOwner(owner);
    },
    [onRevealOwner],
  );

  const setFollowMode = useCallback(
    (enabled: boolean) => {
      followLatestRef.current = enabled;
      setFollowLatest(enabled);
      if (enabled) {
        setFollowNote(null);
        acceptFollowResult(newFollowTarget([], items, matches));
      } else {
        setFollowNote(null);
      }
    },
    [acceptFollowResult, items, matches],
  );

  useEffect(() => {
    const previous = previousObservations.current;
    previousObservations.current = items;
    if (previous !== null && followLatestRef.current) {
      acceptFollowResult(newFollowTarget(previous, items, matches));
    }
  }, [acceptFollowResult, items, matches]);

  useEffect(() => {
    if (navigationType === "POP") pauseFollow();
  }, [navigationType, pauseFollow]);

  return { followLatest, followNote, pauseFollow, pauseForUserControl, setFollowMode };
}
