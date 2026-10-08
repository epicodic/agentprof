// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "@playwright/test";
import { makeSummary } from "../src/test/factories";

const SESSION = "claude-code:11111111-1111-4111-8111-111111111111";
const LONG = `Terminal notification ${"x".repeat(180)} beyond-prefix-needle`;
const SHORT = `${[...LONG].slice(0, 99).join("")}…`;

for (const width of [1280, 390]) {
  test(`limits session and task captions while preserving full content at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/sessions", (route) =>
      route.fulfill({ json: [makeSummary({ id: SESSION, title: LONG })] }),
    );
    await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
      const response = await route.fetch();
      const session = await response.json();
      session.title = LONG;
      session.root.topic = LONG;
      const turn = session.root.children.find((node: { node_id: string }) => node.node_id === "u1");
      turn.topic = LONG;
      turn.children.find((node: { kind: string }) => node.kind === "agent").topic = LONG;
      await route.fulfill({ response, json: session });
    });
    await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/nodes/u1`, async (route) => {
      const response = await route.fetch();
      const detail = await response.json();
      detail.prompt = LONG;
      detail.result = `Result ${LONG}`;
      await route.fulfill({ response, json: detail });
    });
    await page.goto("/");
    const sessionRow = page.getByTestId(`session-row-${SESSION}`);
    await expect(sessionRow.getByText(SHORT, { exact: true }).first()).toBeVisible();
    await expect(sessionRow.getByText(LONG, { exact: true })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Search", exact: true }).fill("beyond-prefix-needle");
    await expect(sessionRow).toBeVisible();
    await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
    await expect(page.getByTestId("tree-row-u1").getByRole("link")).toHaveText(SHORT);
    await expect(page.getByTestId("tree-row-u1").getByRole("link")).toHaveAttribute("title", LONG);
    await expect(page.getByRole("heading", { level: 3, name: SHORT, exact: true })).toBeVisible();
    if (width === 390) await page.getByRole("button", { name: "Agents", exact: true }).click();
    const agentSummary = page.getByTestId(width === 390 ? "agent-summary-card-1" : "agent-summary-row-1");
    await expect(agentSummary.getByRole("link", { name: `Show details: ${SHORT}`, exact: true }).first()).toHaveText(
      SHORT,
    );
    if (width === 390) await page.getByRole("button", { name: "Workflow", exact: true }).click();
    await page.getByTestId("tree-row-u1").getByRole("link").click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Task", exact: true }).locator("xpath=following-sibling::*[1]"),
    ).toHaveText(SHORT);
    await expect(dialog.getByRole("navigation", { name: "Inspected ancestry" }).getByRole("link").last()).toHaveText(
      SHORT,
    );
    await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
    await expect(dialog.getByTestId("sub-agent-toolu_agent1").getByRole("link")).toHaveText(SHORT);
    await expect(dialog.getByTestId("node-timeline").getByRole("link")).toHaveText(SHORT);
    await dialog.getByRole("tab", { name: "Content", exact: true }).click();
    await expect(
      dialog.getByRole("tabpanel", { name: "Content", exact: true }).getByText(LONG, { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("tabpanel", { name: "Content", exact: true }).getByText(`Result ${LONG}`, { exact: true }),
    ).toBeVisible();
  });
}
