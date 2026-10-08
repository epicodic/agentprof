// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, type Locator, test } from "@playwright/test";

const SESSION = "claude-code:11111111-1111-4111-8111-111111111111";

async function openDisclosure(disclosure: Locator): Promise<void> {
  if ((await disclosure.getAttribute("open")) === null) await disclosure.locator("summary").click();
}

test("cost chart uses elapsed time and offers no position-mode control", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("cost-chart")).toBeVisible();
  await expect(dialog.getByLabel("Cost position")).toHaveCount(0);
});

test("activity-track hover does not open floating detail overlays", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  const activity = page
    .getByRole("dialog")
    .getByLabel("Workflow", { exact: true })
    .getByTestId("track-u1")
    .locator('[data-hit-testids*="activity-node-toolu_read1"]')
    .first();
  await expect(activity).toBeVisible();
  await activity.hover();
  await page.waitForTimeout(150);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("marking a call does not change its owner, tab, or collapsed state", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  const dialog = page.getByRole("dialog");
  const callsDisclosure = dialog.getByTestId("workflow-calls");
  if ((await callsDisclosure.getAttribute("open")) !== null) await callsDisclosure.locator("summary").click();
  await expect(callsDisclosure).not.toHaveAttribute("open");
  await dialog.getByTestId("cost-bar-u1-0").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("sel")).toBe("call");
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  await expect(callsDisclosure).not.toHaveAttribute("open");
  await openDisclosure(callsDisclosure);
  const calls = dialog.getByRole("tabpanel");
  const firstCall = calls.getByTestId("call-cost-u1-0");
  await expect(firstCall.getByRole("button", { name: "Expand LLM call 1" })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Workflow", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(firstCall.getByRole("button", { name: "Expand LLM call 1" })).toBeVisible();
  await expect(firstCall.getByTestId("mobile-call-metrics-u1-0")).toHaveCount(0);
});

test("clicking a tree row marks the node without opening its drawer", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await page.getByTestId("tree-row-toolu_agent1").click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBeNull();
  await expect.poll(() => new URL(page.url()).searchParams.get("sel")).toBe("node");
  await expect.poll(() => new URL(page.url()).searchParams.get("entity")).toBe("toolu_agent1");
  await expect(page.getByTestId("tree-row-toolu_agent1")).toHaveAttribute("data-selection", "exact");
  await expect(page.getByTestId("tree-row-session")).toHaveAttribute("data-selection", "none");
  const triangle = page.getByTestId("toggle-toolu_agent1");
  await expect(triangle).toHaveAttribute("aria-label", "Expand");
  await expect(page.getByTestId("tree-row-toolu_agent2")).toHaveCount(0);
  await triangle.click();
  await expect(page.getByTestId("tree-row-toolu_agent2")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect.poll(() => new URL(page.url()).searchParams.has("sel")).toBe(false);
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBeNull();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Enter marks a focused tree row without opening details", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  const row = page.getByTestId("tree-row-u1");
  await row.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("entity")).toBe("u1");
});

test("a row context menu offers explicit inspection without marking or navigation", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  const row = page.getByTestId("tree-row-u1");
  await row.click({ button: "right" });

  const menu = page.getByRole("menu", { name: "Inspection actions" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Show details" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("node")).toBeNull();
  expect(new URL(page.url()).searchParams.get("sel")).toBeNull();

  await menu.getByRole("menuitem", { name: "Show details" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("the details icon explicitly opens the addressed node", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await page.getByTestId("tree-row-u1").getByRole("link", { name: "Show details: Fix the parser" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("Shift+F10 opens the row menu and Escape restores row focus", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  const row = page.getByTestId("tree-row-u1");
  await row.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(new URL(page.url()).searchParams.has("node")).toBe(false);
});

test("Shift+F10 opens the menu for a focused LLM call row", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog.getByTestId("workflow-calls"));
  const call = dialog.getByTestId("call-cost-u1-0");
  await call.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Inspection actions" });
  await expect(menu).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  await menu.getByRole("menuitem", { name: "Show details" }).click();
  await expect(call.getByRole("button", { name: "Collapse LLM call 1" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
});

test("the ContextMenu key handler opens the menu for a focused LLM call row", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  await openDisclosure(page.getByRole("dialog").getByTestId("workflow-calls"));
  const call = page.getByRole("dialog").getByTestId("call-cost-u1-0");
  await call.focus();
  await call.dispatchEvent("keydown", { key: "ContextMenu", bubbles: true });
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toBeVisible();
});

test("touch long press opens the menu and movement cancels it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  const row = page.getByTestId("tree-row-u1");
  await row.dispatchEvent("pointerdown", { pointerType: "touch", clientX: 100, clientY: 100 });
  await page.waitForTimeout(550);
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toBeVisible();
  await row.dispatchEvent("pointerup", { pointerType: "touch", clientX: 100, clientY: 100 });
  await row.dispatchEvent("click");
  expect(new URL(page.url()).searchParams.has("sel")).toBe(false);
  await page.keyboard.press("Escape");

  await row.dispatchEvent("pointerdown", { pointerType: "touch", clientX: 100, clientY: 100 });
  await row.dispatchEvent("pointermove", { pointerType: "touch", clientX: 110, clientY: 100 });
  await page.waitForTimeout(550);
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("sel")).toBe(false);
});

test("unmounting a pressed row cancels its pending long-press menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await page.getByTestId("toggle-toolu_agent1").click();
  const child = page.getByTestId("tree-row-toolu_agent2");
  await expect(child).toBeVisible();
  await child.dispatchEvent("pointerdown", { pointerType: "touch", clientX: 100, clientY: 100 });

  await page.getByTestId("toggle-toolu_agent1").click();
  await expect(child).toHaveCount(0);
  await page.waitForTimeout(550);
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("sel")).toBe(false);
});

test("caption, triangle and context menu stay within phone and desktop viewports", async ({ page }) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(viewport.width);
    const row = page.getByTestId("tree-row-u1");
    const details = row.getByRole("link", { name: "Show details: Fix the parser" });
    const triangle = page.getByTestId("toggle-u1");
    const detailsBox = await details.boundingBox();
    const triangleBox = await triangle.boundingBox();
    if (detailsBox === null || triangleBox === null) throw new Error("Tree action has no visible bounds");
    expect(detailsBox.x).toBeGreaterThanOrEqual(0);
    expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(viewport.width);
    await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Inspection actions" });
    const menuBox = await menu.boundingBox();
    if (menuBox === null) throw new Error("Inspection menu has no visible bounds");
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
    await page.keyboard.press("Escape");
  }
});

test("session list retains direct row navigation without details buttons", async ({ page }) => {
  for (const gesture of ["click", "Enter", " "]) {
    await page.goto("/");
    const row = page.getByTestId(`session-row-${SESSION}`);
    await expect(row.getByRole("button", { name: /Show details:/ })).toHaveCount(0);
    if (gesture === "click") await row.click();
    else {
      await row.focus();
      await page.keyboard.press(gesture);
    }
    await expect(page).toHaveURL(new RegExp(`/sessions/${encodeURIComponent(SESSION)}`));
  }
});

test("diagrams mark and inspect through menus without details buttons", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  const dialog = page.getByRole("dialog");
  const costBar = dialog.getByTestId("cost-bar-u1-1");
  await costBar.click();
  await expect(dialog.getByTestId("cost-section").getByRole("button", { name: /Show details:/ })).toHaveCount(0);
  await costBar.click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem", { name: /Show details/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await dialog
    .getByTestId("context-bar-u1-1")
    .getByRole("button", { name: /Mark context/ })
    .click();
  await expect(dialog.getByTestId("context-chart").getByRole("button", { name: /Show details:/ })).toHaveCount(0);
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await expect(dialog.getByTestId("node-timeline").getByRole("button", { name: /Show details:/ })).toHaveCount(0);
});

test("artifact rows mark locally and explicit details open the producer", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const tool = session.root.children[0].children.find(
      (child: { node_id: string }) => child.node_id === "toolu_read1",
    );
    tool.tool.category = "edit";
    tool.tool.paths = ["marked-artifact.py"];
    tool.tool.writes_file = false;
    await route.fulfill({ response, json: session });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  const dialog = page.getByRole("dialog");
  const artifact = dialog.getByTestId("artifact-marked-artifact.py");
  await expect(artifact).toBeVisible();
  await artifact.click();
  await expect(artifact).toHaveAttribute("data-selection", "local");
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  await expect.poll(() => new URL(page.url()).searchParams.has("sel")).toBe(false);
  await expect(page.getByRole("dialog")).toBeVisible();

  await artifact.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Inspection actions" });
  await expect(menu.getByRole("menuitem", { name: /Show producer:/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /Show producer:/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("toolu_read1");

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  const reopenedArtifact = page.getByRole("dialog").getByTestId("artifact-marked-artifact.py");
  await reopenedArtifact.getByRole("link", { name: "Show details: marked-artifact.py" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("toolu_read1");
});

test("finding rows mark locally and explicit details reveal their agent", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    session.root.children[0].findings = [
      {
        heuristic_id: "W4",
        node_id: "u1",
        severity: "warning",
        message: "A local finding",
        evidence: {},
        estimated_avoidable_cost: { value: null, unit: null, usd: null, provenance: "n/a" },
      },
    ];
    await route.fulfill({ response, json: session });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await page.getByRole("button", { name: /Findings \(/ }).click();
  const finding = page.getByTestId("finding-W4-u1");
  await finding.click();
  await expect(finding).toHaveAttribute("data-selection", "local");
  await expect(page.getByRole("button", { name: /Findings \(/ })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has("node")).toBe(false);
  await expect.poll(() => new URL(page.url()).searchParams.has("sel")).toBe(false);

  await finding.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Inspection actions" });
  await expect(menu.getByRole("menuitem", { name: "Show details" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Show details" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await page.getByRole("button", { name: /Findings \(/ }).click();
  const reopenedFinding = page.getByTestId("finding-W4-u1");
  await reopenedFinding.getByRole("link", { name: "Show details: A local finding" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
});

test("finding groups and evidence expand only through their disclosure triangles", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    session.root.children[0].findings = [
      {
        heuristic_id: "E4",
        node_id: "u1",
        severity: "warning",
        message: "Evidence finding",
        evidence: { event_id: "source-event" },
        estimated_avoidable_cost: { value: null, unit: null, usd: null, provenance: "n/a" },
      },
    ];
    await route.fulfill({ response, json: session });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1`);
  const dialog = page.getByRole("dialog");
  const group = dialog.getByTestId("finding-group-E4");
  await group.getByText("1 finding").click();
  await expect(group.getByText("Evidence finding")).toHaveCount(0);
  await group.getByRole("button", { name: "Expand E4 findings" }).click();
  await expect(group.getByText("Evidence finding")).toBeVisible();
  const evidence = group.getByRole("button", { name: "Expand evidence" });
  await evidence.click();
  await expect(group.getByText(/"event_id": "source-event"/)).toBeVisible();
});
