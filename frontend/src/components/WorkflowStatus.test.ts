// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { WorkflowObservation } from "../lib/workflowState";
import { WorkflowStatus } from "./WorkflowStatus";

function renderStatus(observation: WorkflowObservation): string {
  return renderToStaticMarkup(createElement(MantineProvider, null, createElement(WorkflowStatus, { observation })));
}

const observation = (status: WorkflowObservation["status"]): WorkflowObservation => ({
  status,
  evidence: "unavailable",
  latest: null,
  latestTimedAtMs: null,
  completionRecorded: false,
  taskOwnerId: null,
});

test("renders known states as small light capsules with qualified accessible descriptions", () => {
  for (const [status, label, color] of [
    ["running", "RUNNING", "green"],
    ["waiting", "WAITING", "yellow"],
    ["completed", "COMPLETED", "gray"],
    ["failed", "FAILED", "red"],
  ] as const) {
    const html = renderStatus(observation(status));
    expect(html).toContain(`data-workflow-status="${status}"`);
    expect(html).toContain(`data-size="xs"`);
    expect(html).toContain(`data-variant="light"`);
    expect(html).toContain(`--mantine-color-${color}-light`);
    expect(html).toContain(`>${label}</span>`);
  }

  expect(renderStatus(observation("running"))).toContain("inferred from the latest observed activity");
  expect(renderStatus(observation("completed"))).toContain("Own completion recorded in this session.");
});

test("renders no indicator for unknown state even when completion was recorded", () => {
  const unknown = { ...observation("unknown"), completionRecorded: true };

  expect(renderStatus(unknown)).not.toContain("data-workflow-status");
  expect(renderStatus(unknown)).not.toContain("COMPLETED");
});
