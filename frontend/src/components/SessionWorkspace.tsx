// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Box } from "@mantine/core";
import type { CSSProperties, ReactNode, RefObject } from "react";
import type { SplitterHandlers } from "../hooks/useWorkspaceSplit";
import classes from "./SessionView.module.css";

/** The resizable workspace: the tree pane, the splitter and the collapsible agent-summary pane. */
export function SessionWorkspace({
  workspaceRef,
  bottomOpen,
  mobilePanel,
  treePercent,
  splitterHandlers,
  agentPanelScrollRef,
  onToggleBottom,
  tree,
  agentSummary,
}: {
  workspaceRef: RefObject<HTMLDivElement | null>;
  bottomOpen: boolean;
  mobilePanel: "workflow" | "agents";
  treePercent: number;
  splitterHandlers: SplitterHandlers;
  agentPanelScrollRef: RefObject<HTMLDivElement | null>;
  onToggleBottom: () => void;
  tree: ReactNode;
  agentSummary: ReactNode;
}) {
  return (
    <Box
      ref={workspaceRef}
      data-testid="session-workspace"
      data-bottom-open={bottomOpen}
      data-mobile-panel={mobilePanel}
      className={classes.workspace}
      style={{ "--tree-percent": `${treePercent}%` } as CSSProperties}
    >
      <Box className={classes.treePane}>{tree}</Box>
      <Box
        className={classes.splitter}
        role="separator"
        aria-label="Resize tree and bottom panel"
        aria-orientation="horizontal"
        aria-valuemin={15}
        aria-valuemax={85}
        aria-valuenow={Math.round(treePercent)}
        tabIndex={bottomOpen ? 0 : -1}
        {...splitterHandlers}
        style={{ display: bottomOpen ? undefined : "none" }}
      />
      <Box className={classes.agentsPane}>
        <Box ref={agentPanelScrollRef} id="agent-summary-panel" className={classes.agentsContent} p="sm">
          {agentSummary}
        </Box>
        <Box
          style={{
            alignItems: "end",
            borderTop: "1px solid var(--mantine-color-default-border)",
            display: "flex",
          }}
        >
          <button
            className={classes.desktopAgentTab}
            type="button"
            aria-controls="agent-summary-panel"
            aria-expanded={bottomOpen}
            data-testid="bottom-tab-agent-summary"
            onClick={onToggleBottom}
            style={{
              background: "transparent",
              border: 0,
              borderBottom: bottomOpen ? "2px solid var(--mantine-color-blue-filled)" : "2px solid transparent",
              color: "inherit",
              cursor: "pointer",
              font: "inherit",
              padding: "6px 12px",
            }}
          >
            Agent summary
          </button>
        </Box>
      </Box>
    </Box>
  );
}
