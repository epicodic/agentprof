// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Alert, Button, Group, Text } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { queryKeys, type TranscriptPageOptions } from "../api/client";
import { useTranscriptEntry, useTranscriptPage, useTranscriptSearch } from "../api/hooks";
import type {
  NodeOut,
  TranscriptEntryOut,
  TranscriptPageOut,
  TranscriptSearchHitOut,
  TranscriptSearchOut,
} from "../api/types";
import type { EntityRef } from "../lib/entities";
import { sameEntity } from "../lib/entities";
import { resolveFindingReference } from "../lib/findingReferences";
import { formatTimestamp } from "../lib/format";
import {
  createTranscriptParticipantLabeler,
  transcriptAvailabilityLabel,
  transcriptMessageText,
  transcriptRef,
  transcriptScopeLabel,
} from "../lib/transcript";
import {
  START,
  type TranscriptPosition,
  type TranscriptPositionAction,
  transcriptPositionReducer,
} from "../lib/transcriptPosition";
import { DetailLink } from "./DetailLink";
import { MarkdownMessage } from "./MarkdownMessage";
import { useInspectionMemory, useSessionInteraction } from "./SessionInteraction";
import classes from "./TranscriptSection.module.css";

type TranscriptRow = { kind: "entry"; entry: TranscriptEntryOut } | { kind: "hit"; entry: TranscriptSearchHitOut };
type TranscriptFilter =
  | { kind: "call"; ownerId: string; key: string }
  | { kind: "event"; ownerId: string; id: string }
  | null;

function filterFromSelection(selection: EntityRef | null): TranscriptFilter {
  if (selection?.kind === "call") return { kind: "call", ownerId: selection.ownerId, key: selection.callKey };
  if (selection?.kind === "event") return { kind: "event", ownerId: selection.ownerId, id: selection.eventId };
  return null;
}

function EntryBody({
  sessionId,
  entryId,
  ownerId,
  active,
}: {
  sessionId: string;
  entryId: string;
  ownerId: string;
  active: boolean;
}) {
  const query = useTranscriptEntry(sessionId, entryId, active);
  const interaction = useSessionInteraction();
  if (query.isPending) return <Text size="sm">Loading recorded content…</Text>;
  const detail = query.data;
  if (detail === undefined && query.isError)
    return (
      <Group gap="xs">
        <Text size="sm" c="dimmed">
          Recorded content is unavailable.
        </Text>
        <Button size="xs" variant="subtle" onClick={() => void query.refetch()}>
          Refresh recorded content
        </Button>
      </Group>
    );
  if (detail === undefined) return null;
  if (detail.owner_id !== ownerId)
    return (
      <Text size="sm" c="dimmed">
        This transcript reference is unavailable for its recorded owner.
      </Text>
    );
  const label = transcriptAvailabilityLabel(detail.block_availability);
  const blockKeyCounts = new Map<string, number>();
  return (
    <div className={classes.body} data-testid={`transcript-body-${entryId}`}>
      {detail.blocks.length === 0 ? (
        <Text size="sm">{label}</Text>
      ) : (
        detail.blocks.map((block) => {
          const structured =
            block.data !== null && block.availability !== "encrypted" && block.availability !== "unavailable"
              ? JSON.stringify(block.data, null, 2)
              : null;
          const baseKey = `${block.kind}:${block.native_type ?? ""}:${block.availability}`;
          const occurrence = blockKeyCounts.get(baseKey) ?? 0;
          blockKeyCounts.set(baseKey, occurrence + 1);
          const key = `${baseKey}:${occurrence}`;
          return (
            <div className={classes.block} key={key}>
              <Text className={classes.blockType} size="xs" c="dimmed">
                {block.kind}
                {block.native_type === null ? "" : ` · ${block.native_type}`}
              </Text>
              {block.availability !== "recorded" && (
                <Text size="xs" c="dimmed">
                  {transcriptAvailabilityLabel([block.availability])}
                </Text>
              )}
              {block.text !== null &&
                block.text.length > 0 &&
                (detail.kind === "assistant_message" ||
                detail.kind === "user_message" ||
                detail.kind === "reasoning" ||
                detail.kind === "message" ? (
                  <MarkdownMessage text={transcriptMessageText(block.text, detail.kind, detail.sender)} />
                ) : (
                  <pre className={classes.literal}>{block.text}</pre>
                ))}
              {structured !== null && <pre className={classes.literal}>{structured}</pre>}
              {block.text === "" && structured === null && block.availability === "recorded" && (
                <Text size="sm">Recorded empty</Text>
              )}
              {block.text === null && structured === null && (
                <Text size="sm">{transcriptAvailabilityLabel([block.availability])}</Text>
              )}
            </div>
          );
        })
      )}
      {interaction !== null &&
        detail.references.some(
          (reference) => resolveFindingReference(interaction.root, sessionId, reference) !== null,
        ) && (
          <div className={classes.references}>
            <Text size="xs" fw={600}>
              Supporting references
            </Text>
            {detail.references.map((reference) => {
              const entityRef = resolveFindingReference(interaction.root, sessionId, reference);
              if (entityRef === null) return null;
              return (
                <DetailLink
                  key={`${entityRef.kind}:${JSON.stringify(entityRef)}`}
                  label="Supporting reference"
                  entityRef={entityRef}
                >
                  {reference.label}
                </DetailLink>
              );
            })}
          </div>
        )}
      {query.isError && (
        <Group gap="xs" mt="xs">
          <Text size="xs" c="yellow">
            Refresh failed. The previously loaded content is still shown.
          </Text>
          <Button size="xs" variant="subtle" onClick={() => void query.refetch()}>
            Refresh recorded content
          </Button>
        </Group>
      )}
    </div>
  );
}

function EntryCard({
  sessionId,
  row,
  expanded,
  selected,
  active,
  participantLabel,
  onToggle,
  onMark,
  onBeforeOpen,
}: {
  sessionId: string;
  row: TranscriptRow;
  expanded: boolean;
  selected: boolean;
  active: boolean;
  participantLabel: (entry: TranscriptEntryOut | TranscriptSearchHitOut) => string;
  onToggle: () => void;
  onMark: () => void;
  onBeforeOpen: () => void;
}) {
  const entry = row.entry;
  const entryId = entry.entry_id;
  const preview = row.kind === "hit" ? row.entry.snippet : (row.entry.preview ?? "");
  const availability = row.kind === "hit" ? "Recorded" : transcriptAvailabilityLabel(row.entry.block_availability);
  const ref = transcriptRef(sessionId, entry.owner_id, entryId);
  return (
    <article
      className={classes.entry}
      data-selection={selected ? "exact" : "none"}
      data-testid={`transcript-entry-${entryId}`}
      data-entry-id={entryId}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The transcript row handles Enter and Space directly; its disclosure button remains independently operable.
      tabIndex={0}
      aria-label={`Transcript entry ${entryId}; press Enter or Space to mark`}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onMark();
      }}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button,a,input")) return;
        onMark();
      }}
    >
      <div className={classes.heading}>
        <button
          className={classes.disclosure}
          aria-label={`${expanded ? "Collapse" : "Expand"} transcript entry ${entryId}`}
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          type="button"
        >
          {expanded ? "▾" : "▸"}
        </button>
        <div className={classes.meta}>
          <Text size="sm" fw={600}>
            {participantLabel(entry)}
          </Text>
          {entry.channel !== null && (
            <Text size="xs" c="dimmed">
              {entry.channel}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {formatTimestamp(entry.timestamp.value)}
          </Text>
          <Text size="xs" c="dimmed">
            {availability}
          </Text>
        </div>
      </div>
      <div className={classes.preview}>
        {row.kind === "hit" ? (
          <DetailLink
            label={`Surrounding context for ${entryId}`}
            entityRef={ref}
            destinationTab="content"
            onBeforeOpen={onBeforeOpen}
          >
            {preview || availability}
          </DetailLink>
        ) : (
          preview || availability
        )}
      </div>
      {expanded && <EntryBody sessionId={sessionId} entryId={entryId} ownerId={entry.owner_id} active={active} />}
    </article>
  );
}

export function TranscriptSection({
  sessionId,
  node,
  active,
  panelRef,
}: {
  sessionId: string;
  node: NodeOut;
  active: boolean;
  panelRef: React.RefObject<HTMLDivElement | null>;
}) {
  const interaction = useSessionInteraction();
  const participantLabel = useMemo(
    () => createTranscriptParticipantLabeler(interaction?.root ?? node),
    [interaction?.root, node],
  );
  const queryClient = useQueryClient();
  const prefix = `${node.node_id}:transcript`;
  const [draft, setDraft] = useInspectionMemory(`${prefix}:draft`, () => "");
  const [submitted, setSubmitted] = useInspectionMemory(`${prefix}:submitted`, () => "");
  const [position, setPosition] = useInspectionMemory<TranscriptPosition>(`${prefix}:position`, () => START);
  const { after, anchor, explicitAnchorOwner, retainedAnchor } = position;
  const move = useCallback(
    (action: TranscriptPositionAction) => setPosition((old) => transcriptPositionReducer(old, action)),
    [setPosition],
  );
  const [expandedIds, setExpandedIds] = useInspectionMemory<string[]>(`${prefix}:expanded`, () => []);
  const [followLatest, setFollowLatest] = useInspectionMemory(`${prefix}:follow`, () => false);
  const followLatestRef = useRef(followLatest);
  followLatestRef.current = followLatest;
  const pauseLocalFollow = useCallback(() => {
    followLatestRef.current = false;
    setFollowLatest(false);
  }, [setFollowLatest]);
  const [searchWholeSession, setSearchWholeSession] = useInspectionMemory(`${prefix}:search-whole`, () => false);
  const [submittedWholeSession, setSubmittedWholeSession] = useInspectionMemory(
    `${prefix}:submitted-whole`,
    () => false,
  );
  const [lastFollowedEntry, setLastFollowedEntry] = useInspectionMemory<string | null>(
    `${prefix}:last-followed`,
    () => null,
  );
  const [filter, setFilter] = useInspectionMemory<TranscriptFilter>(`${prefix}:filter`, () =>
    filterFromSelection(interaction?.location.selection ?? null),
  );
  const [filterInitialized, setFilterInitialized] = useInspectionMemory(`${prefix}:filter-initialized`, () => false);
  const [handledRequest, setHandledRequest] = useInspectionMemory<number | null>(
    `${prefix}:handled-request`,
    () => null,
  );
  const [handledFilterRequest, setHandledFilterRequest] = useInspectionMemory<number | null>(
    `${prefix}:handled-filter-request`,
    () => null,
  );
  const request = interaction?.inspectionRequest ?? null;
  const transcriptRefRequest = request?.ref.kind === "transcript" ? request.ref : null;
  const transcriptRequest = transcriptRefRequest?.ownerId === node.node_id && request !== null ? request : null;
  const previousActive = useRef(active);
  const previousFetching = useRef(false);
  const readingAnchor = useRef<{ entryId: string; top: number } | null>(null);
  const pendingExplicitScroll = useRef<{ version: number; entryId: string; ownerId: string } | null>(null);

  useEffect(() => {
    if (
      transcriptRequest === null ||
      transcriptRefRequest === null ||
      request === null ||
      request.version === handledRequest ||
      interaction?.restoringHistory
    )
      return;
    setHandledRequest(request.version);
    setSubmitted("");
    pauseLocalFollow();
    setFilter(null);
    const entryId = transcriptRefRequest.entryId;
    pendingExplicitScroll.current = { version: request.version, entryId, ownerId: transcriptRefRequest.ownerId };
    move({ type: "openEntry", entryId, ownerId: transcriptRefRequest.ownerId });
    setExpandedIds((old) => (old.includes(entryId) ? old : [...old, entryId]));
  }, [
    handledRequest,
    interaction?.restoringHistory,
    request,
    move,
    setExpandedIds,
    setFilter,
    setHandledRequest,
    pauseLocalFollow,
    setSubmitted,
    transcriptRefRequest,
    transcriptRequest,
  ]);

  const invocationRequest =
    request?.ref.kind === "call"
      ? { kind: "call" as const, ownerId: request.ref.ownerId, key: request.ref.callKey }
      : request?.ref.kind === "event"
        ? { kind: "event" as const, ownerId: request.ref.ownerId, id: request.ref.eventId }
        : null;
  useEffect(() => {
    if (
      !active ||
      invocationRequest === null ||
      invocationRequest.ownerId !== node.node_id ||
      request === null ||
      request.version === handledFilterRequest ||
      interaction?.restoringHistory
    )
      return;
    setHandledFilterRequest(request.version);
    setFilter(invocationRequest);
    setSubmitted("");
    move({ type: "restart" });
    pauseLocalFollow();
  }, [
    active,
    handledFilterRequest,
    interaction?.restoringHistory,
    invocationRequest,
    node.node_id,
    request,
    move,
    setFilter,
    pauseLocalFollow,
    setHandledFilterRequest,
    setSubmitted,
  ]);

  useEffect(() => {
    if (active && !previousActive.current && !filterInitialized) {
      setFilter(filterFromSelection(interaction?.location.selection ?? null));
      setFilterInitialized(true);
    }
    previousActive.current = active;
  }, [active, filterInitialized, interaction?.location.selection, setFilter, setFilterInitialized]);

  useEffect(() => {
    const memory = interaction?.memory;
    const restorationVersion = interaction?.restorationVersion ?? 0;
    if (memory === undefined || restorationVersion === 0) return;
    const restore = <T,>(key: string, setValue: (value: T) => void) => {
      const value = memory.get(key);
      if (value !== undefined) setValue(value as T);
    };
    restore(`${prefix}:draft`, setDraft);
    restore(`${prefix}:submitted`, setSubmitted);
    restore(`${prefix}:position`, setPosition);
    restore(`${prefix}:expanded`, setExpandedIds);
    restore(`${prefix}:follow`, setFollowLatest);
    restore(`${prefix}:search-whole`, setSearchWholeSession);
    restore(`${prefix}:submitted-whole`, setSubmittedWholeSession);
    restore(`${prefix}:last-followed`, setLastFollowedEntry);
    restore(`${prefix}:filter`, setFilter);
    restore(`${prefix}:filter-initialized`, setFilterInitialized);
    restore(`${prefix}:handled-request`, setHandledRequest);
    restore(`${prefix}:handled-filter-request`, setHandledFilterRequest);
  }, [
    interaction?.memory,
    interaction?.restorationVersion,
    prefix,
    setPosition,
    setDraft,
    setExpandedIds,
    setFilter,
    setFilterInitialized,
    setFollowLatest,
    setHandledRequest,
    setHandledFilterRequest,
    setSearchWholeSession,
    setSubmittedWholeSession,
    setLastFollowedEntry,
    setSubmitted,
  ]);

  const searching = submitted.trim().length > 0;
  const selection = interaction?.location.selection ?? null;
  const callKey = filter?.kind === "call" && filter.ownerId === node.node_id ? filter.key : undefined;
  const eventId = filter?.kind === "event" && filter.ownerId === node.node_id ? filter.id : undefined;
  const requestedAnchor = anchor ?? (after === null ? retainedAnchor : null);
  const expectedAnchorOwner = anchor !== null ? explicitAnchorOwner : null;
  const cursor =
    anchor !== null
      ? { anchor }
      : after !== null
        ? { after }
        : retainedAnchor !== null
          ? { anchor: retainedAnchor }
          : {};
  const pageOptions: TranscriptPageOptions =
    callKey !== undefined
      ? ({ nodeId: node.node_id, limit: 50, callKey, ...cursor } as TranscriptPageOptions)
      : eventId !== undefined
        ? ({ nodeId: node.node_id, limit: 50, eventId, ...cursor } as TranscriptPageOptions)
        : { nodeId: node.node_id, ...cursor };
  const page = useTranscriptPage(sessionId, pageOptions, active && !searching);
  const search = useTranscriptSearch(
    sessionId,
    { q: submitted, ...(submittedWholeSession ? {} : { nodeId: node.node_id }), ...(after === null ? {} : { after }) },
    active && searching,
  );
  const pageScopeKey = JSON.stringify([node.node_id, callKey, eventId]);
  const [retainedPage, setRetainedPage] = useState<{ key: string; data: TranscriptPageOut } | null>(null);
  useEffect(() => {
    if (page.data !== undefined && !page.isPlaceholderData) setRetainedPage({ key: pageScopeKey, data: page.data });
  }, [page.data, page.isPlaceholderData, pageScopeKey]);
  const pageData = page.data ?? (page.isError && retainedPage?.key === pageScopeKey ? retainedPage.data : undefined);
  const searchScopeKey = `${submittedWholeSession ? "whole" : node.node_id}\u0000${submitted}`;
  const [retainedSearch, setRetainedSearch] = useState<{ key: string; data: TranscriptSearchOut } | null>(null);
  useEffect(() => {
    if (search.data !== undefined && !search.isPlaceholderData)
      setRetainedSearch({ key: searchScopeKey, data: search.data });
  }, [search.data, search.isPlaceholderData, searchScopeKey]);
  const searchData =
    search.data ?? (search.isError && retainedSearch?.key === searchScopeKey ? retainedSearch.data : undefined);
  const allEntries: TranscriptRow[] = searching
    ? (searchData?.hits ?? []).map((entry) => ({ kind: "hit", entry }))
    : (pageData?.entries ?? []).map((entry) => ({ kind: "entry", entry }));
  const requestedAnchorIsAvailable =
    requestedAnchor === null ||
    allEntries.some(
      (row) =>
        row.entry.entry_id === requestedAnchor &&
        (expectedAnchorOwner === null || row.entry.owner_id === expectedAnchorOwner),
    );
  const entries = !searching && !requestedAnchorIsAvailable ? [] : allEntries;
  const metadata = searching ? searchData : pageData;
  const isError = searching ? search.isError : page.isError;
  const isPending = searching ? search.isPending : page.isPending;
  const error = searching ? search.error : page.error;
  const isFetching = searching ? search.isFetching : page.isFetching;
  const selected = selection;
  const scope = transcriptScopeLabel(node, node.kind === "tool");

  const refreshFromStart = () => {
    const basePageOptions: TranscriptPageOptions =
      callKey !== undefined
        ? { nodeId: node.node_id, limit: 50, callKey }
        : eventId !== undefined
          ? { nodeId: node.node_id, limit: 50, eventId }
          : { nodeId: node.node_id };
    const queryKey = searching
      ? queryKeys.transcriptSearch(sessionId, {
          q: submitted,
          ...(submittedWholeSession ? {} : { nodeId: node.node_id }),
        })
      : queryKeys.transcriptPage(sessionId, basePageOptions);
    void queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
    move({ type: "restart" });
  };

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!active || panel === null) return;
    if (isFetching && !previousFetching.current) {
      const panelTop = panel.getBoundingClientRect().top;
      const candidates = [...panel.querySelectorAll<HTMLElement>("[data-entry-id]")];
      const visible = candidates.find((candidate) => candidate.getBoundingClientRect().bottom > panelTop);
      const entryId = visible?.dataset.entryId;
      if (readingAnchor.current === null && visible !== undefined && entryId !== undefined)
        readingAnchor.current = { entryId, top: visible.getBoundingClientRect().top - panelTop };
    } else if (!isFetching && previousFetching.current && readingAnchor.current !== null) {
      const saved = readingAnchor.current;
      previousFetching.current = isFetching;
      if (
        !searching &&
        after === null &&
        anchor === null &&
        retainedAnchor !== saved.entryId &&
        !page.data?.entries.some((entry) => entry.entry_id === saved.entryId)
      ) {
        move({ type: "retain", entryId: saved.entryId });
        return;
      }
      const frame = window.requestAnimationFrame(() => {
        const target = [...panel.querySelectorAll<HTMLElement>("[data-entry-id]")].find(
          (candidate) => candidate.dataset.entryId === saved.entryId,
        );
        if (target !== undefined)
          panel.scrollTop += target.getBoundingClientRect().top - panel.getBoundingClientRect().top - saved.top;
      });
      readingAnchor.current = null;
      return () => window.cancelAnimationFrame(frame);
    }
    previousFetching.current = isFetching;
  }, [active, after, anchor, isFetching, move, page.data, panelRef, retainedAnchor, searching]);

  useLayoutEffect(() => {
    if (interaction?.restoringHistory) {
      pendingExplicitScroll.current = null;
      return;
    }
    const pending = pendingExplicitScroll.current;
    const panel = panelRef.current;
    if (
      !active ||
      searching ||
      pending === null ||
      anchor !== pending.entryId ||
      panel === null ||
      !page.data?.entries.some((entry) => entry.entry_id === pending.entryId && entry.owner_id === pending.ownerId)
    )
      return;
    const frame = window.requestAnimationFrame(() => {
      const target = [...panel.querySelectorAll<HTMLElement>("[data-entry-id]")].find(
        (candidate) => candidate.dataset.entryId === pending.entryId,
      );
      if (target === undefined) return;
      const panelBounds = panel.getBoundingClientRect();
      const targetBounds = target.getBoundingClientRect();
      if (targetBounds.top < panelBounds.top) panel.scrollTop += targetBounds.top - panelBounds.top;
      else if (targetBounds.bottom > panelBounds.bottom) panel.scrollTop += targetBounds.bottom - panelBounds.bottom;
      pendingExplicitScroll.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, anchor, interaction?.restoringHistory, page.data, panelRef, searching]);

  useEffect(() => {
    const explicitRequestPending = transcriptRequest !== null && request !== null && request.version !== handledRequest;
    if (
      !active ||
      !followLatest ||
      !followLatestRef.current ||
      searching ||
      page.data === undefined ||
      explicitRequestPending
    )
      return;
    if (page.data.next_cursor !== null) {
      move({ type: "advance", cursor: page.data.next_cursor });
      return;
    }
    const newest = page.data.entries.at(-1)?.entry_id;
    if (newest !== undefined && newest !== lastFollowedEntry) {
      setLastFollowedEntry(newest);
      move({ type: "follow", entryId: newest });
    }
  }, [
    active,
    handledRequest,
    followLatest,
    searching,
    page.data,
    lastFollowedEntry,
    move,
    setLastFollowedEntry,
    request,
    transcriptRequest,
  ]);

  useLayoutEffect(() => {
    if (!active || !followLatest || searching || page.data?.anchor_index === null || page.data === undefined) return;
    const panel = panelRef.current;
    if (panel === null) return;
    panel.scrollTop = panel.scrollHeight;
  }, [active, followLatest, searching, page.data, panelRef]);

  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const pauseFollow = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-follow-latest]") !== null) return;
      pauseLocalFollow();
    };
    const pauseFollowOnKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-follow-latest]") !== null) return;
      if (
        ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key) ||
        ((event.key === "Enter" || event.key === " ") &&
          event.target instanceof Element &&
          event.target.closest("button, a") !== null)
      )
        pauseLocalFollow();
    };
    panel.addEventListener("wheel", pauseFollow, { passive: true });
    panel.addEventListener("touchstart", pauseFollow, { passive: true });
    panel.addEventListener("pointerdown", pauseFollow);
    panel.addEventListener("keydown", pauseFollowOnKey);
    return () => {
      panel.removeEventListener("wheel", pauseFollow);
      panel.removeEventListener("touchstart", pauseFollow);
      panel.removeEventListener("pointerdown", pauseFollow);
      panel.removeEventListener("keydown", pauseFollowOnKey);
    };
  }, [panelRef, pauseLocalFollow]);
  const openSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = draft.trim();
    if (query.length === 0) return;
    setSubmitted(query);
    move({ type: "restart" });
    setFollowLatest(false);
    setSubmittedWholeSession(searchWholeSession);
  };

  return (
    <section className={classes.root} aria-label="Recorded transcript" data-testid="transcript-section">
      <form className={classes.search} onSubmit={openSearch}>
        <label htmlFor={`transcript-search-${node.node_id}`}>Search recorded content</label>
        <div className={classes.searchControls}>
          <input
            id={`transcript-search-${node.node_id}`}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            type="search"
          />
          <Button type="submit" size="xs">
            Search
          </Button>
          {searching && (
            <Button
              type="button"
              size="xs"
              variant="subtle"
              onClick={() => {
                setSubmitted("");
                move({ type: "leaveSearch" });
              }}
            >
              Clear search
            </Button>
          )}
        </div>
        <label className={classes.scopeLabel} htmlFor={`transcript-scope-${node.node_id}`}>
          Search scope
        </label>
        <select
          id={`transcript-scope-${node.node_id}`}
          value={searchWholeSession ? "whole" : "owner"}
          onChange={(event) => setSearchWholeSession(event.currentTarget.value === "whole")}
        >
          <option value="owner">{scope}</option>
          <option value="whole">Whole session</option>
        </select>
        {draft.length > 0 && draft.trim().length === 0 && (
          <Text size="xs" c="red">
            Enter a search term.
          </Text>
        )}
      </form>

      <Group justify="space-between" align="center">
        <Text size="sm" fw={600}>
          {searching ? "Search results" : "Recorded transcript"}
        </Text>
        <Group gap="xs">
          {filter !== null && (
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                setFilter(null);
                move({ type: "restart" });
              }}
            >
              Clear invocation filter
            </Button>
          )}
          <Button
            data-follow-latest
            aria-describedby={searching ? `transcript-follow-hint-${node.node_id}` : undefined}
            size="xs"
            variant={followLatest ? "filled" : "light"}
            aria-pressed={followLatest}
            disabled={searching}
            onClick={() => {
              if (!followLatest) {
                setSubmitted("");
                move({ type: "leaveSearch" });
              }
              setFollowLatest((value) => {
                const next = !value;
                followLatestRef.current = next;
                return next;
              });
            }}
          >
            {followLatest ? "Following latest" : "Follow latest"}
          </Button>
        </Group>
      </Group>
      {searching && (
        <Text id={`transcript-follow-hint-${node.node_id}`} size="xs" c="dimmed">
          Follow latest is unavailable while searching.
        </Text>
      )}
      {metadata !== undefined && metadata.coverage.reasons.length > 0 && (
        <Text size="xs" c="dimmed">
          Coverage: {metadata.coverage.reasons.join(" · ")}
        </Text>
      )}
      {isPending && metadata === undefined && <Text size="sm">Loading transcript metadata…</Text>}
      {isError && metadata === undefined && (
        <Alert color="yellow">
          {requestedAnchor !== null
            ? "This transcript entry is unavailable."
            : error instanceof Error
              ? error.message
              : "Transcript metadata is unavailable."}
          {requestedAnchor !== null && (
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                refreshFromStart();
              }}
            >
              Refresh transcript
            </Button>
          )}
        </Alert>
      )}
      {isError && metadata !== undefined && (
        <Alert color="yellow">
          Transcript refresh failed. The loaded window is still shown.
          <Button
            size="xs"
            variant="subtle"
            onClick={() => {
              if (requestedAnchor !== null || after !== null) refreshFromStart();
              else if (searching) void search.refetch();
              else void page.refetch();
            }}
          >
            Refresh transcript
          </Button>
        </Alert>
      )}
      {metadata !== undefined && entries.length === 0 && (
        <Group gap="xs">
          <Text size="sm">
            {searching
              ? `No matches for “${submitted}”.`
              : requestedAnchor !== null
                ? "This entry is no longer available in the transcript."
                : `No recorded content in this ${scope.toLowerCase()}.`}
          </Text>
          {!searching && requestedAnchor !== null && (
            <Button size="xs" variant="subtle" onClick={refreshFromStart}>
              Refresh transcript
            </Button>
          )}
        </Group>
      )}
      <div className={classes.entries}>
        {entries.map((row) => {
          const ref = transcriptRef(sessionId, row.entry.owner_id, row.entry.entry_id);
          return (
            <EntryCard
              key={row.entry.entry_id}
              sessionId={sessionId}
              row={row}
              expanded={expandedIds.includes(row.entry.entry_id)}
              selected={sameEntity(selected, ref)}
              active={active}
              participantLabel={participantLabel}
              onBeforeOpen={pauseLocalFollow}
              onToggle={() =>
                setExpandedIds((old) =>
                  old.includes(row.entry.entry_id)
                    ? old.filter((id) => id !== row.entry.entry_id)
                    : [...old, row.entry.entry_id],
                )
              }
              onMark={() => interaction?.selectEntity(ref)}
            />
          );
        })}
      </div>
      {metadata !== undefined && (metadata.previous_cursor !== null || metadata.next_cursor !== null) && (
        <Group justify="space-between">
          <Button
            size="xs"
            variant="light"
            disabled={metadata.previous_cursor === null}
            onClick={() => {
              move({ type: "page", cursor: metadata.previous_cursor });
            }}
          >
            Previous
          </Button>
          <Button
            size="xs"
            variant="light"
            disabled={metadata.next_cursor === null}
            onClick={() => {
              move({ type: "page", cursor: metadata.next_cursor });
            }}
          >
            Next
          </Button>
        </Group>
      )}
    </section>
  );
}
