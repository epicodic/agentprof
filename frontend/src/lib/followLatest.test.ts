// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "vitest";
import { followNote, followOwner } from "./followLatest";

test("a follow result maps to the note shown next to the toggle", () => {
  expect(followNote({ reason: "target", ownerId: "a1" })).toBeNull();
  expect(followNote({ reason: "none", ownerId: null })).toBe("No new activity in this view");
  expect(followNote({ reason: "ambiguous", ownerId: null })).toBe("Latest activity ordering unavailable");
  expect(followNote({ reason: "target", ownerId: null })).toBe("Latest activity ordering unavailable");
});

test("only a target result with an owner names an owner to reveal", () => {
  expect(followOwner({ reason: "target", ownerId: "a1" })).toBe("a1");
  expect(followOwner({ reason: "target", ownerId: null })).toBeNull();
  expect(followOwner({ reason: "none", ownerId: null })).toBeNull();
  expect(followOwner({ reason: "ambiguous", ownerId: null })).toBeNull();
});
