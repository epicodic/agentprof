// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ActivityStatus } from "./ActivityStatus";

function render(activity: "running" | "waiting"): string {
  return renderToStaticMarkup(createElement(MantineProvider, null, createElement(ActivityStatus, { activity })));
}

test("renders running and waiting activity labels", () => {
  const running = render("running");
  const waiting = render("waiting");

  expect(running).toContain("RUNNING");
  expect(running).toContain("This agent has unfinished work at the latest observed activity.");
  expect(waiting).toContain("WAITING");
  expect(waiting).toContain("This agent is waiting for an active sub-agent to finish.");
});
