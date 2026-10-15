// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { type KeyboardEvent, type PointerEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { initialSplitPercent, splitPercentAfterDrag, stepSplitPercent } from "../lib/splitPane";

const SPLIT_STORAGE_KEY = "agentprof:session-workspace-split";

/** The pointer and keyboard handlers of the splitter. */
export interface SplitterHandlers {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/** The tree/bottom split of the session workspace, remembered in local storage. */
export function useWorkspaceSplit(onUserControl: () => void): {
  workspaceRef: RefObject<HTMLDivElement | null>;
  treePercent: number;
  splitterHandlers: SplitterHandlers;
} {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [treePercent, setTreePercent] = useState(() =>
    initialSplitPercent(typeof window === "undefined" ? null : window.localStorage.getItem(SPLIT_STORAGE_KEY)),
  );

  useEffect(() => {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, String(treePercent));
  }, [treePercent]);

  const resize = useCallback(
    (clientY: number) => {
      onUserControl();
      const bounds = workspaceRef.current?.getBoundingClientRect();
      if (bounds === undefined) return;
      setTreePercent(splitPercentAfterDrag(clientY - bounds.top, bounds.height));
    },
    [onUserControl],
  );

  const splitterHandlers: SplitterHandlers = {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      resize(event.clientY);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientY);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const next = stepSplitPercent(treePercent, event.key);
      if (next === null) return;
      event.preventDefault();
      onUserControl();
      setTreePercent(next);
    },
  };

  return { workspaceRef, treePercent, splitterHandlers };
}
