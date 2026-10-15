// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "vitest";
import { initialTreeReveal, treeRevealReducer } from "./treeReveal";

test("toggle adds and removes one key", () => {
  const state = initialTreeReveal(["a"], null);

  const opened = treeRevealReducer(state, { type: "toggle", key: "b" });
  const closed = treeRevealReducer(opened, { type: "toggle", key: "a" });

  expect([...opened.expanded]).toEqual(["a", "b"]);
  expect([...closed.expanded]).toEqual(["b"]);
});

test("reveal expands the path and bumps the tree version even for the same target", () => {
  const state = initialTreeReveal([], null);

  const first = treeRevealReducer(state, { type: "reveal", target: "n1", keys: ["s", "n1"] });
  const again = treeRevealReducer(first, { type: "reveal", target: "n1", keys: [] });

  expect(state.tree).toEqual({ version: 0, target: null });
  expect(first.tree).toEqual({ version: 1, target: "n1" });
  expect(again.tree).toEqual({ version: 2, target: "n1" });
  expect([...again.expanded]).toEqual(["s", "n1"]);
  expect(again.workflow).toEqual({ version: 0, target: null });
});

test("an initial target starts at version 1", () => {
  expect(initialTreeReveal(["k"], "n1").tree).toEqual({ version: 1, target: "n1" });
});

test("revealWorkflow bumps only the workflow request", () => {
  const state = treeRevealReducer(initialTreeReveal([], null), {
    type: "revealWorkflow",
    target: "t",
    keys: ["t"],
  });

  expect(state.workflow).toEqual({ version: 1, target: "t" });
  expect(state.tree).toEqual({ version: 0, target: null });
  expect([...state.expanded]).toEqual(["t"]);
});

test("expand adds keys and restore replaces the set; neither bumps a version", () => {
  const expanded = treeRevealReducer(initialTreeReveal(["a"], null), { type: "expand", keys: ["b"] });
  const restored = treeRevealReducer(expanded, { type: "restore", expanded: ["z"] });

  expect([...expanded.expanded]).toEqual(["a", "b"]);
  expect([...restored.expanded]).toEqual(["z"]);
  expect(restored.tree.version).toBe(0);
  expect(restored.workflow.version).toBe(0);
});

test("toggle and reveal return a new set and leave the input state untouched", () => {
  const state = initialTreeReveal(["a"], null);

  const toggled = treeRevealReducer(state, { type: "toggle", key: "b" });
  const revealed = treeRevealReducer(state, { type: "reveal", target: "n", keys: ["n"] });

  expect(toggled.expanded).not.toBe(state.expanded);
  expect(revealed.expanded).not.toBe(state.expanded);
  expect([...state.expanded]).toEqual(["a"]);
  expect(state.tree).toEqual({ version: 0, target: null });
});
