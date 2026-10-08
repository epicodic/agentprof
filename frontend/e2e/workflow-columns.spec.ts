// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, type Locator, test } from "@playwright/test";

const SESSION = "claude-code:11111111-1111-4111-8111-111111111111";

async function openDisclosure(disclosure: Locator): Promise<void> {
  if ((await disclosure.getAttribute("open")) === null) await disclosure.locator("summary").click();
}

test("long workflow topics leave headings and metrics readable at desktop drawer widths", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children[0];
    turn.topic = `Terminal notification: ${"send_to_terminal_command_completed_".repeat(12)}`;
    turn.model = "copilot/claude-sonnet-5.5";
    await route.fulfill({ response, json: session });
  });
  await page.setViewportSize({ width: 1159, height: 870 });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=session&tab=workflow`);
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog.getByTestId("workflow-children"));
  const row = dialog.getByTestId("turn-u1");
  await expect(row).toBeVisible();
  const table = row.locator("xpath=ancestor::table");
  for (const expanded of [false, true]) {
    if (expanded) await dialog.getByRole("button", { name: "Expand details", exact: true }).click();
    expect((await table.locator("thead").boundingBox())?.height).toBeLessThan(45);
    expect((await row.boundingBox())?.height).toBeLessThan(65);
    for (const label of ["Start", "Duration", "Tokens", "Own cost", "Total cost"]) {
      const cell = row.locator(`td[data-label="${label}"]`);
      expect(await cell.locator("p").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(table.locator("thead")).toBeHidden();
  await expect(row.locator('td[data-label="Topic"]')).toContainText("Terminal notification");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
