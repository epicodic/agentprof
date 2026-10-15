// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "vitest";
import { START, transcriptPositionReducer } from "./transcriptPosition";

const somewhere = { after: "c1", anchor: "e1", explicitAnchorOwner: "u1", retainedAnchor: "e0" };

test("opening an entry anchors on it for its owner", () => {
  expect(transcriptPositionReducer(somewhere, { type: "openEntry", entryId: "e9", ownerId: "a2" })).toEqual({
    after: null,
    anchor: "e9",
    explicitAnchorOwner: "a2",
    retainedAnchor: null,
  });
});

test("paging moves the cursor and drops all anchors", () => {
  expect(transcriptPositionReducer(somewhere, { type: "page", cursor: "c2" })).toEqual({ ...START, after: "c2" });
  expect(transcriptPositionReducer(somewhere, { type: "page", cursor: null })).toEqual(START);
});

test("restart goes back to the start", () => {
  expect(transcriptPositionReducer(somewhere, { type: "restart" })).toEqual(START);
});

test("leaving a search drops the cursor and the retained anchor but keeps the anchor and its owner", () => {
  expect(transcriptPositionReducer(somewhere, { type: "leaveSearch" })).toEqual({
    ...somewhere,
    after: null,
    retainedAnchor: null,
  });
});

test("advancing follows a cursor, drops the anchor and keeps the explicit owner", () => {
  expect(transcriptPositionReducer(somewhere, { type: "advance", cursor: "c3" })).toEqual({
    after: "c3",
    anchor: null,
    explicitAnchorOwner: "u1",
    retainedAnchor: null,
  });
});

test("following the newest entry sets only the anchor", () => {
  expect(transcriptPositionReducer(somewhere, { type: "follow", entryId: "e5" })).toEqual({
    ...somewhere,
    anchor: "e5",
  });
});

test("retaining sets only the retained anchor", () => {
  expect(transcriptPositionReducer(somewhere, { type: "retain", entryId: "e5" })).toEqual({
    ...somewhere,
    retainedAnchor: "e5",
  });
});
