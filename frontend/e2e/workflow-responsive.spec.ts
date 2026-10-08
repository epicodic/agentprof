// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "@playwright/test";
import { makeSummary } from "../src/test/factories";
import {
  assertNoSelectionActionControls,
  installDeepWorkflow,
  installWorkflowDetail,
  WORKFLOW_SESSION,
} from "./helpers/workflowFixture";

const sessionUrl = `/sessions/${encodeURIComponent(WORKFLOW_SESSION)}`;

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test("phone session list keeps all fields reachable, disclosures local, and row navigation direct", async ({
  page,
}) => {
  const longPath = `/workspace/${"a-very-long-directory-name/".repeat(18)}project`;
  const records = Array.from({ length: 53 }, (_, index) =>
    makeSummary({
      id: `claude-code:list-${String(index).padStart(2, "0")}`,
      title: `Session ${index} ${"with a very long title ".repeat(7)}`,
      workspace: longPath,
      start_ms: 1_700_000_000_000 + index * 1000,
      end_ms: 1_700_000_001_000 + index * 1000,
      last_activity_ms: 1_700_000_002_000 + index * 1000,
      cost_total: index === 1 ? null : { value: index, unit: "USD", usd: index, provenance: "exact" },
      state: index === 0 ? "error" : "summarized",
      error: index === 0 ? "A long summary error that remains readable without a tooltip." : null,
    }),
  );
  records[0] = makeSummary({
    ...records[0],
    id: WORKFLOW_SESSION,
    title: `Fixture ${"with a very long title ".repeat(7)}`,
  });
  await page.route("**/api/sessions", (route) => route.fulfill({ json: records }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expectNoHorizontalOverflow(page);
  await assertNoSelectionActionControls(page);

  await expect(page.getByLabel("Sort sessions")).toBeVisible();
  await page.getByLabel("Sort sessions").selectOption("start");
  await page.getByLabel("Sort direction").selectOption("asc");
  await expect(page.getByTestId(`session-row-${WORKFLOW_SESSION}`)).toBeVisible();
  await assertNoSelectionActionControls(page);
  const scroller = page.getByRole("region", { name: "Sessions table" });
  const table = scroller.locator("table");
  await expect(table.locator("thead th")).toHaveCount(7);
  await expect(table.getByRole("columnheader", { name: "Start" })).toBeAttached();
  await expect(table.getByRole("columnheader", { name: "Last activity" })).toBeAttached();
  const workspaceDisclosure = table.locator("details").filter({ hasText: longPath }).first();
  await expect(workspaceDisclosure).toBeAttached();
  await workspaceDisclosure.locator("summary").click();
  await expect(workspaceDisclosure).toHaveAttribute("open", "");
  await expect(workspaceDisclosure).toContainText(longPath);
  await assertNoSelectionActionControls(page);
  await page.keyboard.press("Enter");
  await expect(workspaceDisclosure).not.toHaveAttribute("open", "");
  await expect(workspaceDisclosure.locator(":scope > :not(summary)")).toBeHidden();
  await expect(page).toHaveURL("/");

  const errorDisclosure = table.getByText("A long summary error that remains readable without a tooltip.", {
    exact: true,
  });
  await expect(errorDisclosure).toBeHidden();
  await table.getByTestId("summary-error-disclosure").first().click();
  await expect(errorDisclosure).toBeVisible();
  await expect(page).toHaveURL("/");
  await assertNoSelectionActionControls(page);

  await page.getByRole("textbox", { name: "Rows per page" }).click();
  await page.getByRole("option", { name: "25" }).click();
  await expect(page.getByTestId(`session-row-${WORKFLOW_SESSION}`)).toBeVisible();
  await page.getByRole("button", { name: "2", exact: true }).click();
  await expect(page.getByTestId("session-row-claude-code:list-25")).toBeVisible();
  await assertNoSelectionActionControls(page);
  await page.getByLabel("Search").fill("Fixture");
  await expect(page.getByTestId(`session-row-${WORKFLOW_SESSION}`)).toBeVisible();
  await page.getByTestId(`session-row-${WORKFLOW_SESSION}`).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/sessions/${encodeURIComponent(WORKFLOW_SESSION)}`));
  await assertNoSelectionActionControls(page);
});

test("phone agent cards expose sorting, labeled metrics, topic inspection and selection independently", async ({
  page,
}) => {
  await installDeepWorkflow(page, 20, 0, true);
  await installWorkflowDetail(page, "deep-20");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${sessionUrl}?scope=deep-20`);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await assertNoSelectionActionControls(page);
  await expect(page.getByTestId("agent-summary-cards")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const agent = page.getByTestId("agent-summary-card-122");
  await expect(agent).toContainText("Representative topic");
  await expect(agent).not.toContainText("Latest task");
  await expect(agent).toContainText("Latest observed activity");
  await expect(agent.locator('[data-workflow-status="running"]')).toHaveText("RUNNING");
  const metricsToggle = agent.locator('summary[aria-label="Agent 122 metrics"]');
  const metricsCaption = page.getByTestId("agent-summary-metrics-caption-122");
  await expect(metricsCaption).toBeVisible();
  await metricsCaption.click();
  await expect(agent.locator("details[open]")).toHaveCount(0);
  await expect(agent).toHaveAttribute("data-selection", "exact");
  await expect(metricsCaption).toBeVisible();
  await metricsToggle.focus();
  await page.keyboard.press("Enter");
  await expect(agent.locator("details[open]")).toHaveCount(1);
  const cardBounds = await agent.boundingBox();
  const metricBounds = await page.getByTestId("agent-summary-metrics-122").boundingBox();
  expect(metricBounds?.width).toBeGreaterThanOrEqual((cardBounds?.width ?? 0) - 24);
  for (const label of [
    "Model",
    "Duration",
    "Own cost",
    "Cost share denominator",
    "Input tokens",
    "Output tokens",
    "Total tokens",
    "Cache TTL",
    "Resumes",
  ]) {
    await expect(agent.getByText(label, { exact: true })).toBeVisible();
  }
  await page.keyboard.press("Enter");
  await expect(agent.locator("details[open]")).toHaveCount(0);
  await expect(metricsCaption).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(agent.locator("details[open]")).toHaveCount(1);
  const representativeTopicLink = agent.getByRole("link", { name: "Show details: Inspect deep worker" });
  await representativeTopicLink.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toHaveCount(0);
  await expect(page).toHaveURL(`${sessionUrl}?scope=deep-20&sel=node&entity=deep-20`);
  await page.getByTestId("agent-summary-metrics-caption-122").click();
  await expect(agent).toHaveAttribute("data-selection", "exact");
  expect(cardBounds).not.toBeNull();
  const touchPoint = { x: (cardBounds?.x ?? 0) + 20, y: (cardBounds?.y ?? 0) + 20 };
  await agent.dispatchEvent("pointerdown", {
    pointerId: 44,
    pointerType: "touch",
    button: 0,
    clientX: touchPoint.x,
    clientY: touchPoint.y,
  });
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toBeVisible();
  await agent.dispatchEvent("pointerup", {
    pointerId: 44,
    pointerType: "touch",
    button: 0,
    clientX: touchPoint.x,
    clientY: touchPoint.y,
  });
  await agent.dispatchEvent("click", { button: 0 });
  await expect(agent).toHaveAttribute("data-selection", "exact");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toHaveCount(0);
  await agent.focus();
  await page.keyboard.press("Enter");
  await expect(agent).toHaveAttribute("data-selection", "exact");
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-20");
  await expect.poll(() => new URL(page.url()).searchParams.get("sel")).toBe("node");
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBeNull();
  await page.keyboard.press("Space");
  await expect(agent).toHaveAttribute("data-selection", "exact");

  await page.getByLabel("Sort agents").selectOption("model");
  await page.getByLabel("Sort direction").selectOption("desc");
  await assertNoSelectionActionControls(page);
  await expect(page.getByLabel("Sort agents")).toHaveValue("model");
  await expect(page.getByLabel("Sort direction")).toHaveValue("desc");
  const restoredMetrics = page.getByTestId("agent-summary-card-122").locator("details[open]");
  await expect(restoredMetrics).toBeVisible();
  await page.getByLabel("Scope target").selectOption("deep-19");
  await page.getByRole("button", { name: "Focus subtree" }).click();
  await assertNoSelectionActionControls(page);
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-19");
  await page.getByLabel("Sort agents").selectOption("agentId");
  await page.getByLabel("Sort direction").selectOption("asc");
  await page.getByTestId("agent-summary-card-122").locator('summary[aria-label="Agent 122 metrics"]').click();
  await expect(page.getByTestId("agent-summary-card-122").locator("details[open]")).toHaveCount(0);
  await assertNoSelectionActionControls(page);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-20");
  await expect(page.getByLabel("Sort agents")).toHaveValue("model");
  await expect(page.getByLabel("Sort direction")).toHaveValue("desc");
  await expect(page.getByTestId("agent-summary-card-122").locator("details[open]")).toHaveCount(1);
  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-19");
  await expect(page.getByLabel("Sort agents")).toHaveValue("agentId");
  await expect(page.getByTestId("agent-summary-card-122").locator("details[open]")).toHaveCount(0);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-20");
  await expect(page.getByLabel("Sort agents")).toHaveValue("model");

  await page
    .getByTestId("agent-summary-card-122")
    .getByRole("link", { name: "Show details: Inspect deep worker" })
    .click();
  await expect(page.getByRole("tabpanel", { name: "Overview" })).toContainText("Recorded task for deep-20");
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-20");
  await expect(page.getByTestId("agent-summary-card-122")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("phone hierarchy keeps independent touch targets, depth, costs and focus access", async ({ page }) => {
  await installDeepWorkflow(page, 20, 1000);
  await installWorkflowDetail(page, "deep-20");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${sessionUrl}?node=deep-20`);
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Close details" }).click();
  const renderedRows = page.locator('[data-testid^="tree-row-"]');
  await expect.poll(() => renderedRows.count()).toBeLessThan(100);
  const deepRow = page.getByTestId("tree-row-deep-20");
  await expect(deepRow).toContainText("Depth 22");
  await expect(page.getByTestId("phone-meta-deep-20").locator('[data-workflow-status="running"]')).toHaveText(
    "RUNNING",
  );
  const metaBounds = await page.getByTestId("phone-meta-deep-20").boundingBox();
  const statusBounds = await page.getByTestId("phone-meta-deep-20").locator("[data-workflow-status]").boundingBox();
  expect(metaBounds?.height).toBe(32);
  expect(statusBounds?.height).toBeLessThanOrEqual(18);
  expect((statusBounds?.y ?? 0) + (statusBounds?.height ?? 0)).toBeLessThanOrEqual(
    (metaBounds?.y ?? 0) + (metaBounds?.height ?? 0),
  );
  const selectionBeforeFocus = await deepRow.getAttribute("data-selection");
  await deepRow.focus();
  await page.keyboard.press("Shift+F10");
  const focus = page.getByRole("menuitem", { name: "Focus subtree", exact: true });
  const focusBounds = await focus.boundingBox();
  expect(focusBounds?.height).toBeGreaterThanOrEqual(44);
  await focus.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-20");
  await expect(deepRow).toHaveAttribute("data-selection", selectionBeforeFocus ?? "none");
  const deepTopic = deepRow.getByRole("link", { name: /Show details:/ });
  await deepTopic.focus();
  await expect(deepTopic).toBeFocused();
  await deepTopic.click();
  await expect(page.getByRole("tabpanel", { name: "Overview" })).toContainText("Recorded task for deep-20");
  await expectNoHorizontalOverflow(page);
});

test("phone workspace switches preserve scroll and return to desktop geometry", async ({ page }) => {
  await installDeepWorkflow(page, 20, 1000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(sessionUrl);
  await assertNoSelectionActionControls(page);
  const workflow = page.getByRole("button", { name: "Workflow", exact: true });
  const agents = page.getByRole("button", { name: "Agents", exact: true });
  await expect(workflow).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("grid", { name: "Call tree" })).toBeVisible();
  const zoomControls = page.getByRole("group", { name: "Timeline zoom controls" });
  await expect(zoomControls).toBeVisible();
  expect(await zoomControls.getByRole("slider").count()).toBeGreaterThan(0);
  const root = page.getByTestId("tree-row-session");
  await expect(root).toContainText("Depth 0");
  await expect(root).toContainText("Own cost");
  await expect(root).toContainText("Subtree cost");
  const topicBounds = await root.getByRole("link", { name: /Show details: Fix the parser/ }).boundingBox();
  expect(topicBounds?.height).toBeGreaterThanOrEqual(44);
  const triangleBounds = await page.getByTestId("toggle-session").boundingBox();
  expect(triangleBounds?.width).toBeGreaterThanOrEqual(44);
  expect(triangleBounds?.height).toBeGreaterThanOrEqual(44);
  await root.click();
  await expect(root).toHaveAttribute("data-selection", "exact");
  const triangle = page.getByTestId("toggle-session");
  await triangle.click();
  await expect(page.getByTestId("tree-row-turn")).toHaveCount(0);
  await triangle.click();
  await expect(page.getByTestId("tree-row-turn")).toBeVisible();
  await page.getByTestId("toggle-turn").click();
  const treeScroll = page.locator('[data-testid="tree-scroll"]');
  await treeScroll.evaluate((element) => {
    element.scrollTop = Math.min(800, element.scrollHeight);
  });
  const scrollTop = await treeScroll.evaluate((element) => element.scrollTop);
  await agents.click();
  await assertNoSelectionActionControls(page);
  await expect(agents).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("agent-summary-cards")).toBeVisible();
  await workflow.click();
  await assertNoSelectionActionControls(page);
  await expect.poll(() => treeScroll.evaluate((element) => element.scrollTop)).toBe(scrollTop);

  const breakpointAnchor = await treeScroll.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll<HTMLElement>('[data-testid^="tree-row-"]')].find(
      (candidate) => candidate.getBoundingClientRect().bottom > bounds.top,
    );
    return {
      key: row?.getAttribute("data-testid"),
      offset: row === undefined ? 0 : bounds.top - row.getBoundingClientRect().top,
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await assertNoSelectionActionControls(page);
  await expect(page.getByRole("separator", { name: "Resize tree and bottom panel" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Workflow", exact: true })).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoSelectionActionControls(page);
  await expect(page.getByRole("button", { name: "Workflow", exact: true })).toBeVisible();
  await expect
    .poll(() =>
      treeScroll.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const row = [...element.querySelectorAll<HTMLElement>('[data-testid^="tree-row-"]')].find(
          (candidate) => candidate.getBoundingClientRect().bottom > bounds.top,
        );
        return {
          key: row?.getAttribute("data-testid"),
          offset: row === undefined ? 0 : bounds.top - row.getBoundingClientRect().top,
        };
      }),
    )
    .toEqual({ key: breakpointAnchor.key, offset: Math.min(breakpointAnchor.offset, 29) });
  await expect.poll(() => page.locator('[data-testid^="tree-row-"]').count()).toBeGreaterThan(0);
  await expectNoHorizontalOverflow(page);
});

test("phone activity track and genuine fixture details remain usable", async ({ page }) => {
  await installDeepWorkflow(page, 20);
  await installWorkflowDetail(page, "deep-20");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(sessionUrl);
  const track = page.getByTestId("track-u1");
  const trackBounds = await track.boundingBox();
  expect(trackBounds?.height).toBeGreaterThanOrEqual(44);
  const actual = page.getByTestId("tree-row-toolu_agent1");
  await actual.getByRole("link", { name: /Show details:/ }).click();
  await expect(page.getByRole("tabpanel", { name: "Overview" })).toContainText("Look at the tests");
  await page.getByRole("button", { name: "Close details" }).click();
  await expectNoHorizontalOverflow(page);
});

test("phone context ancestors keep their own qualified state beside the neutral context label", async ({ page }) => {
  await installDeepWorkflow(page, 20);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${sessionUrl}?scope=deep-0&activity=running`);
  const row = page.getByTestId("tree-row-deep-0");
  await expect(row).toHaveAttribute("data-context-only", "true");
  const meta = page.getByTestId("phone-meta-deep-0");
  await expect(meta).toContainText("Depth 2");
  await expect(meta.locator('[data-workflow-status="waiting"]')).toHaveText("WAITING");
  await expect(meta).toContainText("Context ancestor");
  const metaBounds = await meta.boundingBox();
  const statusBounds = await meta.locator("[data-workflow-status]").boundingBox();
  expect(metaBounds?.height).toBe(32);
  expect(statusBounds?.height).toBeLessThanOrEqual(18);
  expect((statusBounds?.y ?? 0) + (statusBounds?.height ?? 0)).toBeLessThanOrEqual(
    (metaBounds?.y ?? 0) + (metaBounds?.height ?? 0),
  );
});

test("phone inspected ancestry scrolls locally and keeps drawer tabs usable", async ({ page }) => {
  await installDeepWorkflow(page, 20);
  await installWorkflowDetail(page, "deep-20");
  await installWorkflowDetail(page, "deep-19");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${sessionUrl}?node=deep-20`);
  const drawer = page.getByRole("dialog");
  const ancestry = drawer.getByRole("navigation", { name: "Inspected ancestry" });
  const initial = await ancestry.evaluate((element) => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(initial.height).toBeLessThanOrEqual(128);
  expect(initial.scrollHeight).toBeGreaterThan(initial.height);

  const links = ancestry.getByRole("link", { name: /^Show details:/ });
  const finalAncestor = links.last();
  await finalAncestor.focus();
  const bounds = await finalAncestor.boundingBox();
  const ancestryBounds = await ancestry.boundingBox();
  if (bounds === null || ancestryBounds === null) throw new Error("phone ancestry focus target has no bounds");
  expect(bounds.y).toBeGreaterThanOrEqual(ancestryBounds.y);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(ancestryBounds.y + ancestryBounds.height);
  expect(await ancestry.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await links.nth((await links.count()) - 2).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("deep-19");
  await expect(drawer.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
  await expect(drawer.getByRole("tabpanel", { name: "Overview" })).toContainText("Recorded task for deep-19");
});

test("desktop hierarchy retains the compact fixed row and metric headers", async ({ page }) => {
  await installDeepWorkflow(page, 20, 1000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(sessionUrl);
  const row = page.getByTestId("tree-row-session");
  expect((await row.boundingBox())?.height).toBeLessThanOrEqual(30);
  const tree = page.getByRole("grid", { name: "Call tree" });
  await expect(tree.getByRole("columnheader", { name: "Duration" })).toBeVisible();
  await expect(tree.getByRole("columnheader", { name: "Context" })).toBeVisible();
  await expect(page.getByRole("separator", { name: "Resize tree and bottom panel" })).toBeVisible();
});

test("phone long press opens Focus and the menu item has a touch target", async ({ page }) => {
  await installDeepWorkflow(page, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(sessionUrl);
  const row = page.getByTestId("tree-row-turn");
  const bounds = await row.boundingBox();
  if (bounds === null) throw new Error("turn row has no visible bounds");
  await row.dispatchEvent("pointerdown", {
    pointerId: 1,
    pointerType: "touch",
    clientX: bounds.x + 20,
    clientY: bounds.y + 20,
  });
  await page.waitForTimeout(550);
  await row.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch" });
  const focus = page.getByRole("menuitem", { name: "Focus subtree", exact: true });
  await expect(focus).toBeVisible();
  expect((await focus.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await assertNoSelectionActionControls(page);
  await focus.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("turn");
  await assertNoSelectionActionControls(page);
});

test("phone tree track individual and grouped activity hits keep 44px bounds at timeline edges", async ({ page }) => {
  await installDeepWorkflow(page, 20);
  await installWorkflowDetail(page, "deep-20");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${sessionUrl}?node=deep-20`);
  await page.getByRole("button", { name: "Close details" }).click();

  const deepTrack = page.getByTestId("tree-row-deep-20").getByTestId("track-deep-20");
  const deepHit = deepTrack.locator('[data-testid^="timeline-call-deep-20-"]');
  await expect(deepHit).toBeVisible();
  const deepTrackBounds = await deepTrack.boundingBox();
  expect(deepTrackBounds?.width ?? 0).toBeGreaterThanOrEqual(44);
  const deepHitBounds = await deepHit.boundingBox();
  if (deepTrackBounds === null || deepHitBounds === null) throw new Error("deep activity hit has no bounds");
  expect(deepHitBounds.width).toBeGreaterThanOrEqual(44);
  expect(deepHitBounds.height).toBeGreaterThanOrEqual(44);
  expect(deepHitBounds.x).toBeGreaterThanOrEqual(deepTrackBounds.x);
  expect(deepHitBounds.x - deepTrackBounds.x).toBeLessThanOrEqual(2);

  const treeScroll = page.getByTestId("tree-scroll");
  await treeScroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  const overlappingTrack = page.getByTestId("track-u1");
  const groupedHit = overlappingTrack.getByRole("button", { name: /^Mark overlapping activity:/ }).first();
  await expect(groupedHit).toBeVisible();
  await expect.poll(async () => (await groupedHit.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
  await expect.poll(async () => (await groupedHit.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

  const zoomControls = page.getByRole("group", { name: "Timeline zoom controls" });
  const startSlider = zoomControls.getByRole("slider").first();
  await startSlider.focus();
  for (let index = 0; index < 200; index += 1) await page.keyboard.press("ArrowRight");
  await expect.poll(async () => Number(await startSlider.getAttribute("aria-valuenow"))).toBeGreaterThan(90);
  const edgeTrack = overlappingTrack;
  const edgeHits = edgeTrack.locator('button[aria-label^="Select "], button[aria-label^="Mark overlapping activity:"]');
  await expect.poll(() => edgeHits.count()).toBeGreaterThan(0);
  const edgeTrackBounds = await edgeTrack.boundingBox();
  if (edgeTrackBounds === null) throw new Error("session activity track has no bounds");
  for (let index = 0; index < (await edgeHits.count()); index += 1) {
    const bounds = await edgeHits.nth(index).boundingBox();
    if (bounds === null) throw new Error(`timeline edge hit ${index} has no bounds`);
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.x).toBeGreaterThanOrEqual(edgeTrackBounds.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(edgeTrackBounds.x + edgeTrackBounds.width + 1);
  }
});
