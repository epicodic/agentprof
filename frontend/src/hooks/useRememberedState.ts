// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { useLayoutEffect, useRef, useState } from "react";
import { useSessionInteraction } from "../components/SessionInteraction";

/** A value remembered in the session's inspection memory under `key` and restored on back/forward navigation. */
export function useRememberedState<T>(
  key: string,
  initial: () => T,
  isValid: (value: unknown) => value is T,
  saveSnapshot: () => void,
): [T, (next: T | ((previous: T) => T)) => void] {
  const interaction = useSessionInteraction();
  const [value, setValue] = useState<T>(() => {
    const saved = interaction?.memory.get(key);
    return isValid(saved) ? saved : initial();
  });
  const valueRef = useRef(value);
  valueRef.current = value;
  const update = (next: T | ((previous: T) => T)) => {
    const resolved = typeof next === "function" ? (next as (previous: T) => T)(valueRef.current) : next;
    valueRef.current = resolved;
    interaction?.memory.set(key, resolved);
    setValue(resolved);
    saveSnapshot();
  };
  const restoredVersion = useRef(interaction?.restorationVersion ?? 0);
  useLayoutEffect(() => {
    if (interaction?.restoringHistory || interaction?.restorationVersion === restoredVersion.current) return;
    restoredVersion.current = interaction?.restorationVersion ?? 0;
    const saved = interaction?.memory.get(key);
    if (isValid(saved)) {
      valueRef.current = saved;
      setValue(saved);
    }
  }, [interaction?.memory, interaction?.restorationVersion, interaction?.restoringHistory, isValid, key]);
  return [value, update];
}
