// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

/** Where the transcript window sits: a page cursor or an anchor entry, with the anchor's provenance. */
export interface TranscriptPosition {
  after: string | null;
  anchor: string | null;
  explicitAnchorOwner: string | null;
  retainedAnchor: string | null;
}

export const START: TranscriptPosition = { after: null, anchor: null, explicitAnchorOwner: null, retainedAnchor: null };

export type TranscriptPositionAction =
  /** An explicit request to show one entry of its owner. */
  | { type: "openEntry"; entryId: string; ownerId: string }
  /** Previous or next page: a cursor and no anchors. */
  | { type: "page"; cursor: string | null }
  /** Back to the first page: refresh, new search, new or cleared filter. */
  | { type: "restart" }
  /** Clear search or turn follow on: drop the cursor and the retained anchor only. */
  | { type: "leaveSearch" }
  /** Follow mode moves to the next page: the explicit owner is kept. */
  | { type: "advance"; cursor: string }
  /** Follow mode anchors on the newest entry. */
  | { type: "follow"; entryId: string }
  /** Keep the reading position across a refetch. */
  | { type: "retain"; entryId: string };

export function transcriptPositionReducer(
  state: TranscriptPosition,
  action: TranscriptPositionAction,
): TranscriptPosition {
  switch (action.type) {
    case "openEntry":
      return { after: null, anchor: action.entryId, explicitAnchorOwner: action.ownerId, retainedAnchor: null };
    case "page":
      return { ...START, after: action.cursor };
    case "restart":
      return START;
    case "leaveSearch":
      return { ...state, after: null, retainedAnchor: null };
    case "advance":
      return { ...state, after: action.cursor, anchor: null, retainedAnchor: null };
    case "follow":
      return { ...state, anchor: action.entryId };
    case "retain":
      return { ...state, retainedAnchor: action.entryId };
  }
}
