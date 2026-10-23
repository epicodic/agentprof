// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

/** A request to scroll a tree row into view; `version` changes on every request, even for the same target. */
interface RevealRequest {
  version: number;
  target: string | null;
}

/** The expanded tree rows and the latest reveal requests of the tree and of workflow navigation. */
export interface TreeRevealState {
  expanded: Set<string>;
  tree: RevealRequest;
  workflow: RevealRequest;
}

export type TreeRevealAction =
  | { type: "toggle"; key: string }
  | { type: "expand"; keys: Iterable<string> }
  | { type: "restore"; expanded: Iterable<string> }
  | { type: "reveal"; target: string; keys: Iterable<string> }
  | { type: "revealWorkflow"; target: string; keys: Iterable<string> };

/** The state for a new page: the given rows expanded and an optional first reveal target. */
export function initialTreeReveal(expanded: Iterable<string>, revealTarget: string | null): TreeRevealState {
  return {
    expanded: new Set(expanded),
    tree: { version: revealTarget === null ? 0 : 1, target: revealTarget },
    workflow: { version: 0, target: null },
  };
}

/** Applies one action and returns the next state; the expanded set is never mutated in place. */
export function treeRevealReducer(state: TreeRevealState, action: TreeRevealAction): TreeRevealState {
  switch (action.type) {
    case "toggle": {
      const expanded = new Set(state.expanded);
      if (expanded.has(action.key)) expanded.delete(action.key);
      else expanded.add(action.key);
      return { ...state, expanded };
    }
    case "expand":
      return { ...state, expanded: new Set([...state.expanded, ...action.keys]) };
    case "restore":
      return { ...state, expanded: new Set(action.expanded) };
    case "reveal":
      return {
        ...state,
        expanded: new Set([...state.expanded, ...action.keys]),
        tree: { version: state.tree.version + 1, target: action.target },
      };
    case "revealWorkflow":
      return {
        ...state,
        expanded: new Set([...state.expanded, ...action.keys]),
        workflow: { version: state.workflow.version + 1, target: action.target },
      };
  }
}
