// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, type Locator, test } from "@playwright/test";
import { assertNoSelectionActionControls } from "./helpers/workflowFixture";

const SESSION = "claude-code:11111111-1111-4111-8111-111111111111";
const sessionUrl = `/sessions/${encodeURIComponent(SESSION)}`;

async function openDisclosure(disclosure: Locator): Promise<void> {
  if ((await disclosure.getAttribute("open")) === null) await disclosure.locator("summary").click();
}

test("tree captions navigate while row metrics only mark and use the arrow cursor", async ({ page }) => {
  await page.goto(sessionUrl);
  await assertNoSelectionActionControls(page);
  const row = page.getByTestId("tree-row-u1");
  const caption = row.getByRole("link", { name: "Show details: Fix the parser" });
  await expect(caption).toBeVisible();
  await expect(row.getByRole("button", { name: /Show details:/ })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Details", exact: true })).toHaveCount(0);
  expect(await caption.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  const metric = page.getByTestId("tree-duration-u1");
  expect(await metric.evaluate((el) => getComputedStyle(el).cursor)).toBe("default");
  await metric.click();
  await expect(row).toHaveAttribute("data-selection", "exact");
  await assertNoSelectionActionControls(page);
  expect(new URL(page.url()).searchParams.get("node")).toBeNull();
  await caption.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  await assertNoSelectionActionControls(page);
});

test("workflow table and timeline captions open the child while metrics mark", async ({ page }) => {
  await page.goto(`${sessionUrl}?node=session&tab=workflow`);
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog.getByTestId("workflow-children"));
  const row = dialog.getByTestId("turn-u1");
  await row.locator('td[data-label="Duration"]').click();
  await expect(row).toHaveAttribute("data-selection", "exact");
  expect(new URL(page.url()).searchParams.get("node")).toBe("session");
  await expect(row.locator('td[data-label="Details"]')).toHaveCount(0);
  await row.getByRole("link", { name: "Show details: Fix the parser" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  await assertNoSelectionActionControls(page);
  await page.goto(`${sessionUrl}?node=session&tab=workflow`);
  await openDisclosure(dialog.getByTestId("workflow-children"));
  await dialog.getByTestId("node-timeline").getByRole("link", { name: "Show details: Fix the parser" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  await assertNoSelectionActionControls(page);
});

test("call and tool captions open inspection without using the disclosure triangle", async ({ page }) => {
  await page.goto(`${sessionUrl}?node=u1&tab=workflow`);
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog.getByTestId("workflow-calls"));
  const call = dialog.getByTestId("call-cost-u1-0");
  await call.locator('td[data-label="Duration"]').click();
  await expect(call.getByRole("button", { name: "Expand LLM call 1" })).toBeVisible();
  await call.getByRole("link", { name: "Show details: LLM call 1" }).click();
  await expect(call.getByRole("button", { name: "Collapse LLM call 1" })).toBeVisible();
  const tool = dialog.locator('tr[data-testid^="tool-execution-u1-"]').first();
  await tool.getByRole("link", { name: /^Show details:/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("toolu_read1");
});

test("finding rows announce their mark and keep caption navigation separate", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    session.root.children[0].findings = [
      {
        heuristic_id: "W4",
        node_id: "u1",
        severity: "warning",
        message: "Inspect this finding",
        evidence: {},
        estimated_avoidable_cost: { value: null, unit: null, usd: null, provenance: "n/a" },
      },
    ];
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl);
  await assertNoSelectionActionControls(page);
  await page.getByRole("button", { name: /Findings \(/ }).click();
  const finding = page.getByRole("row", { name: "Mark finding: Inspect this finding" });
  await expect(finding).toHaveAttribute("aria-selected", "false");
  await finding.focus();
  await page.keyboard.press("Enter");
  await expect(finding).toHaveAttribute("aria-selected", "true");
  expect(new URL(page.url()).searchParams.get("node")).toBeNull();
  const caption = finding.getByRole("link", { name: "Show details: Inspect this finding" });
  expect(await caption.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  expect(await finding.evaluate((el) => getComputedStyle(el).cursor)).toBe("default");
  await caption.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  await assertNoSelectionActionControls(page);
});

test("caption Enter and modified clicks keep their native URL at phone and desktop sizes", async ({
  page,
  context,
}) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(sessionUrl);
    const row = page.getByTestId("tree-row-u1");
    const caption = row.getByRole("link", { name: "Show details: Fix the parser" });
    const href = await caption.getAttribute("href");
    expect(href).not.toBeNull();
    expect(new URL(href ?? "", page.url()).searchParams.get("node")).toBe("u1");

    await caption.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
    await assertNoSelectionActionControls(page);
    await page.goto(sessionUrl);
    await assertNoSelectionActionControls(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const modifiedPagePromise = context.waitForEvent("page", { timeout: 5000 });
    await caption.click({ modifiers: ["Control"] });
    const modifiedPage = await modifiedPagePromise;
    await expect(modifiedPage).toHaveURL(new URL(href ?? "", page.url()).href);
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(row).toHaveAttribute("data-selection", "none");
    await assertNoSelectionActionControls(page);
    await modifiedPage.close();
  }
});
