// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { NodeOut } from "../api/types";
import { truncateTitle } from "../lib/format";
import type { ActivityFilter } from "../lib/workflowState";
import classes from "./WorkflowToolbar.module.css";

export interface WorkflowScopeOption {
  node: NodeOut;
  depth: number;
}

export function WorkflowToolbar({
  options,
  pendingScope,
  activity,
  invalidScope,
  invalidActivity,
  matchCount,
  onPendingScope,
  onFocus,
  onWholeSession,
  onActivity,
  onExpandMatches,
  followLatest,
  followNote,
  onFollowLatest,
}: {
  options: WorkflowScopeOption[];
  pendingScope: string;
  activity: ActivityFilter;
  invalidScope: boolean;
  invalidActivity: boolean;
  matchCount: number;
  onPendingScope: (nodeId: string) => void;
  onFocus: () => void;
  onWholeSession: () => void;
  onActivity: (value: ActivityFilter) => void;
  onExpandMatches: () => void;
  followLatest: boolean;
  followNote: string | null;
  onFollowLatest: (enabled: boolean) => void;
}) {
  return (
    <section className={classes.toolbar} aria-label="Workflow controls">
      <label>
        Scope target
        <select value={pendingScope} onChange={(event) => onPendingScope(event.currentTarget.value)}>
          {options.map(({ node, depth }) => {
            const fullCaption = `${node.topic} · ${node.kind} · depth ${depth}`;
            return (
              <option key={node.node_id} value={node.node_id} title={fullCaption}>
                {truncateTitle(fullCaption)}
              </option>
            );
          })}
        </select>
      </label>
      <button type="button" onClick={onFocus}>
        Focus subtree
      </button>
      <button type="button" onClick={onWholeSession}>
        Whole session
      </button>
      <label>
        Activity filter
        <select value={activity} onChange={(event) => onActivity(event.currentTarget.value as ActivityFilter)}>
          <option value="all">All activity</option>
          <option value="running">Running · inferred</option>
          <option value="waiting">Waiting · inferred</option>
          <option value="completed">Completion recorded</option>
          <option value="failed">Failure recorded</option>
          <option value="unknown">State unknown</option>
        </select>
      </label>
      <button type="button" onClick={onExpandMatches} disabled={matchCount === 0}>
        Expand matching paths
      </button>
      <button
        type="button"
        data-testid="follow-latest-toggle"
        aria-pressed={followLatest}
        onClick={() => onFollowLatest(!followLatest)}
      >
        {followLatest ? "Following latest" : "Follow latest"}
      </button>
      {followNote !== null ? (
        <span className={classes.followNote} role="status">
          {followNote}
        </span>
      ) : (
        <span className={classes.followNote} aria-hidden="true">
          &nbsp;
        </span>
      )}
      {invalidScope && <span role="status">Workflow scope unavailable; showing the whole session</span>}
      {invalidActivity && <span role="status">Activity filter unavailable; showing all activity</span>}
    </section>
  );
}
