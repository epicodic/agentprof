// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Box } from "@mantine/core";

/** The polite status messages above the workspace: empty filters, copy failure and unavailable selection. */
export function SessionStatusMessages({
  noMatches,
  activityFiltered,
  onClearActivity,
  clipboardError,
  unavailable,
  selectedOutsideWorkflow,
}: {
  noMatches: boolean;
  activityFiltered: boolean;
  onClearActivity: () => void;
  clipboardError: boolean;
  unavailable: boolean;
  selectedOutsideWorkflow: boolean;
}) {
  return (
    <>
      {noMatches && (
        <Box role="status" aria-live="polite">
          No hierarchy rows match these filters.
          {activityFiltered && (
            <button type="button" onClick={onClearActivity}>
              Clear activity filter
            </button>
          )}
        </Box>
      )}
      {clipboardError && (
        <Box role="status" aria-live="polite" style={{ fontSize: "var(--mantine-font-size-xs)" }}>
          Unable to copy detail link.
        </Box>
      )}
      {unavailable && (
        <Box role="status" aria-live="polite">
          Selected item unavailable
        </Box>
      )}
      {!unavailable && selectedOutsideWorkflow && (
        <Box role="status" aria-live="polite">
          Selected item is outside this workflow scope or filter
        </Box>
      )}
    </>
  );
}
