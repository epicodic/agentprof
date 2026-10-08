// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { TextInput } from "@mantine/core";
import { useCallback, useEffect, useRef } from "react";
import type { SequenceOrder } from "../lib/executionSequence";
import { useInspectionMemory, useSessionInteraction } from "./SessionInteraction";

export interface SequenceSettings {
  query: string;
  order: SequenceOrder;
  descending: boolean;
}

export function useSequenceSettings(
  ownerId: string,
  tableRole: string,
): [SequenceSettings, (next: SequenceSettings | ((old: SequenceSettings) => SequenceSettings)) => void] {
  const key = `sequence:${ownerId}:${tableRole}`;
  const interaction = useSessionInteraction();
  const [saved, setSaved] = useInspectionMemory<SequenceSettings>(key, () => ({
    query: "",
    order: "chronological",
    descending: true,
  }));
  const settings: SequenceSettings = {
    query: typeof saved.query === "string" ? saved.query : "",
    order:
      saved.order === "cost" || saved.order === "duration" || saved.order === "tokens" ? saved.order : "chronological",
    descending: typeof saved.descending === "boolean" ? saved.descending : true,
  };
  const hasLegacyMode = Object.hasOwn(saved, "mode");
  const normalizedQuery = settings.query;
  const normalizedOrder = settings.order;
  const normalizedDescending = settings.descending;
  useEffect(() => {
    if (hasLegacyMode || typeof saved.descending !== "boolean")
      setSaved({ query: normalizedQuery, order: normalizedOrder, descending: normalizedDescending });
  }, [hasLegacyMode, saved.descending, normalizedQuery, normalizedOrder, normalizedDescending, setSaved]);
  const lastRevealVersion = useRef(interaction?.revealVersion ?? 0);
  useEffect(() => {
    const version = interaction?.revealVersion ?? 0;
    if (lastRevealVersion.current === version) return;
    lastRevealVersion.current = version;
    const saved = interaction?.memory.get(key);
    if (saved !== undefined) setSaved(saved as SequenceSettings);
  }, [interaction?.revealVersion, interaction?.memory, key, setSaved]);
  const setSettings = useCallback(
    (next: SequenceSettings | ((old: SequenceSettings) => SequenceSettings)) => {
      setSaved((old) => {
        const normalized: SequenceSettings = {
          query: typeof old.query === "string" ? old.query : "",
          order:
            old.order === "cost" || old.order === "duration" || old.order === "tokens" ? old.order : "chronological",
          descending: typeof old.descending === "boolean" ? old.descending : true,
        };
        const value = typeof next === "function" ? next(normalized) : next;
        return { query: value.query, order: value.order, descending: value.descending };
      });
    },
    [setSaved],
  );
  return [settings, setSettings];
}

export function SequenceControls({
  ownerId,
  settings,
  onChange,
}: {
  ownerId: string;
  settings: SequenceSettings;
  onChange: (settings: SequenceSettings | ((old: SequenceSettings) => SequenceSettings)) => void;
}) {
  return (
    <div data-testid={`sequence-controls-${ownerId}`}>
      <TextInput
        label="Search calls and tools"
        aria-label="Search calls and tools"
        value={settings.query}
        onChange={(event) => onChange({ ...settings, query: event.currentTarget.value })}
        size="xs"
      />
    </div>
  );
}
