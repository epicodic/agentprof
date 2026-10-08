// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { AgentBadge } from "./AgentBadge";

function render(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(MantineProvider, null, element));
}

test("renders the agent number in a color capsule", () => {
  const html = render(createElement(AgentBadge, { agentId: 2, active: true }));

  expect(html).toContain("2");
  expect(html).toContain("--agent-hue:137.507764");
});
