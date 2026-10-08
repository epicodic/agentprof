// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, type Locator, test } from "@playwright/test";
import { formatDuration } from "../src/lib/format";
import { makeExecutionEvent, metric } from "../src/test/factories";

const SESSION = "claude-code:11111111-1111-4111-8111-111111111111";

async function openDisclosure(disclosure: Locator): Promise<void> {
  if ((await disclosure.getAttribute("open")) === null) await disclosure.locator("summary").click();
}
const nodeUrl = (node: string) => `/sessions/${encodeURIComponent(SESSION)}?node=${node}`;

test("grouped findings retain every message and evidence", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    turn.findings = ["first", "second"].map((message) => ({
      heuristic_id: "E4",
      node_id: "u1",
      severity: "warning",
      message,
      evidence: { event_id: message },
      estimated_avoidable_cost: { value: null, unit: null, usd: null, provenance: "n/a" },
    }));
    await route.fulfill({ response, json: session });
  });

  await page.goto(nodeUrl("u1"));
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Expand E4 findings" }).click();
  await expect(dialog.getByText("first", { exact: true })).toBeVisible();
  await expect(dialog.getByText("second", { exact: true })).toBeVisible();
  const evidenceButtons = dialog.getByRole("button", { name: "Expand evidence" });
  await evidenceButtons.first().click();
  await expect(dialog.getByText(/"event_id": "first"/)).toBeVisible();
  await dialog.getByRole("button", { name: "Expand evidence" }).click();
  await expect(dialog.getByText(/"event_id": "second"/)).toBeVisible();
});

test("details separate overview, workflow and source content", async ({ page }) => {
  await page.goto(nodeUrl("u1"));
  const dialog = page.getByRole("dialog");
  const overview = dialog.getByRole("tab", { name: "Overview" });
  await expect(overview).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByTestId("metrics-cost-own")).toBeVisible();

  await dialog.getByRole("tab", { name: "Workflow" }).click();
  await expect(dialog.getByTestId("node-timeline")).toBeVisible();
  await expect(dialog.getByTestId("context-section")).toBeVisible();
  await openDisclosure(dialog.getByTestId("workflow-children"));
  await expect(dialog.getByTestId("sub-agent-toolu_agent1")).toBeVisible();

  await dialog.getByRole("tab", { name: "Workflow" }).click();
  await openDisclosure(dialog.getByTestId("workflow-calls"));
  await expect(dialog.getByTestId("cost-chart")).toBeVisible();
  await expect(dialog.getByTestId("call-cost-u1-1")).toBeVisible();

  await dialog.getByRole("tab", { name: "Content" }).click();
  await expect(dialog.getByRole("heading", { name: "Prompt", exact: true })).toBeVisible();
});

test("node content shows a loading state until its detail request finishes", async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/nodes/u1`, async (route) => {
    await gate;
    await route.fulfill({ response: await route.fetch() });
  });

  try {
    await page.goto(nodeUrl("u1"));
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "Content", exact: true }).click();
    await expect(dialog.getByTestId("node-detail-loading")).toBeVisible();
    release();
    await expect(dialog.getByRole("heading", { name: "Prompt", exact: true })).toBeVisible();
    await expect(dialog.getByTestId("node-detail-loading")).toHaveCount(0);
  } finally {
    release();
  }
});

test("node content reports a detail request error and other tabs remain usable", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/nodes/u1`, (route) =>
    route.fulfill({ status: 500, body: "detail unavailable" }),
  );

  await page.goto(nodeUrl("u1"));
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Content", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await expect(dialog.getByTestId("node-timeline")).toBeVisible();
});

test("session cost chart marks its turn call and tab switching retains explicit expansion", async ({ page }) => {
  await page.goto(nodeUrl("session"));
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  const callsDisclosure = dialog.getByTestId("workflow-calls");
  if ((await callsDisclosure.getAttribute("open")) !== null) await callsDisclosure.locator("summary").click();
  await dialog.getByTestId("cost-bar-u1-0").click();
  const calls = dialog.getByRole("tabpanel");
  await expect(callsDisclosure).not.toHaveAttribute("open");
  await openDisclosure(callsDisclosure);
  await calls.getByTestId("expand-call-turn-u1").click();
  await expect(calls.getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "exact");
  await calls.getByTestId("call-cost-u1-0").getByRole("button", { name: "Expand LLM call 1" }).click();

  await dialog.getByRole("tab", { name: "Content" }).click();
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  const collapse = calls.getByRole("button", { name: "Collapse LLM call 1" });
  await expect(collapse).toBeVisible();
  await collapse.click();
  await dialog.getByTestId("cost-bar-u1-0").click();
  await expect(calls.getByTestId("call-cost-u1-0").getByRole("button", { name: "Expand LLM call 1" })).toBeVisible();
});

test("drawer fills a phone viewport and keeps navigation usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(nodeUrl("u1"));
  const dialog = page.getByRole("dialog");
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(389);

  await dialog.getByRole("tab", { name: "Workflow" }).click();
  const callsTab = dialog.getByRole("tab", { name: "Workflow" });
  await expect(callsTab).toHaveAttribute("aria-selected", "true");
  const callsPanel = dialog.getByRole("tabpanel", { name: "Workflow" });
  await openDisclosure(callsPanel.getByTestId("workflow-calls"));
  await page.setViewportSize({ width: 390, height: 390 });
  await expect.poll(() => callsPanel.evaluate((panel) => panel.scrollHeight > panel.clientHeight)).toBe(true);
  await callsPanel.evaluate((panel) => {
    panel.scrollTop = panel.scrollHeight;
  });
  await expect.poll(() => callsPanel.evaluate((panel) => panel.scrollTop)).toBeGreaterThan(0);
  await expect(dialog.getByRole("tab", { name: "Overview" })).toBeInViewport();
  await expect(dialog.locator(".mantine-Drawer-header")).toBeInViewport();
  await expect(dialog.getByRole("banner").getByRole("button", { name: "Close details", exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  await openDisclosure(dialog.getByTestId("workflow-children"));
  await dialog
    .getByTestId("sub-agent-toolu_agent1")
    .getByRole("link", { name: /Show details:/ })
    .click();
  await expect(page).toHaveURL(/node=toolu_agent1/);
  await page.goBack();
  await expect(page).toHaveURL(/node=u1/);
});

test("drawer can expand, restore and resize on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(nodeUrl("u1"));
  const dialog = page.getByRole("dialog");
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBeLessThan(1000);

  await dialog.getByRole("button", { name: "Expand details" }).click();
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(1439);
  await dialog.getByRole("button", { name: "Restore width" }).click();
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBeLessThan(1000);

  const slider = dialog.getByLabel("Detail width");
  await slider.focus();
  await slider.press("Home");
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue("46");
  for (let index = 0; index < 29; index += 1) {
    await slider.press("ArrowRight");
  }
  await expect(slider).toHaveValue("75");
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBeGreaterThan(1000);
});

test("phone call summaries fit and expanded metrics remain accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    const call = turn.llm_calls[1];
    turn.execution_events = [
      makeExecutionEvent({
        event_id: "tool-start:phone-read",
        kind: "tool_start",
        subject_node_id: "toolu_read1",
        start: metric(call.start.value + 50),
      }),
      makeExecutionEvent({
        event_id: "tool-result:phone-read",
        kind: "tool_result",
        subject_node_id: "toolu_read1",
        start: metric(call.start.value + 100),
      }),
    ];
    await route.fulfill({ response, json: session });
  });
  await page.goto(nodeUrl("u1"));
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  const panel = dialog.getByRole("tabpanel");
  await openDisclosure(panel.getByTestId("workflow-calls"));
  await expect
    .poll(() => panel.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(0);
  const row = panel.getByTestId("call-cost-u1-1");
  expect((await row.boundingBox())?.height).toBeLessThanOrEqual(32);
  const scroll = panel.getByTestId("calls-scroll-u1");
  await expect.poll(() => scroll.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
  await row.getByRole("button", { name: "Expand LLM call 2" }).click();
  const metrics = row.locator("xpath=following-sibling::tr[1]");
  await expect(metrics).toBeVisible();
  for (const label of [
    "Since start",
    "Input",
    "Cache read",
    "Cache write",
    "Cache write 5m",
    "Cache write 1h",
    "Output",
  ]) {
    await expect(metrics).toContainText(label);
  }
  await expect(panel.getByLabel("Search calls and tools")).toBeVisible();
  await expect(panel.getByLabel("Sequence mode")).toHaveCount(0);
  await expect(panel.getByLabel("Sequence order")).toHaveCount(0);
  const invocation = panel.getByTestId("tool-execution-u1-subject:toolu_read1");
  await expect(invocation).toHaveCount(1);
  await invocation.getByRole("button", { name: "Expand Read" }).click();
  await expect(
    invocation.locator("xpath=following-sibling::tr[1]").getByText("Source evidence", { exact: true }),
  ).toHaveCount(0);
  await invocation.locator("xpath=following-sibling::tr[1]").getByRole("link", { name: "Open tool details" }).click();
  await expect(dialog.getByRole("tab", { name: "Content", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tabpanel").getByText("def parse():")).toBeVisible();
});

test("phone trailing execution event retains its known since-start metric", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let expectedOffset = "";
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    const tool = structuredClone(turn.children.find((child: { node_id: string }) => child.node_id === "toolu_read1"));
    const lastCallStart = Math.max(...turn.llm_calls.map((call: { start: { value: number } }) => call.start.value));
    tool.node_id = "test-trailing";
    tool.start.value = lastCallStart + 1000;
    expectedOffset = formatDuration(tool.start.value - session.root.start.value);
    turn.children.push(tool);
    turn.execution_events = [
      makeExecutionEvent({
        event_id: "phone-trailing-tool-result",
        kind: "tool_result",
        subject_node_id: tool.node_id,
        start: metric(tool.start.value),
        execution_start: metric(tool.start.value),
        execution_end: metric(tool.end.value),
        success: true,
      }),
    ];
    await route.fulfill({ response, json: session });
  });

  await page.goto(nodeUrl("u1"));
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  const panel = dialog.getByRole("tabpanel");
  const invocation = panel.getByTestId("tool-execution-u1-subject:test-trailing");
  await expect(invocation.locator('td[data-label="Time"]')).toContainText(expectedOffset);
});

test("tool invocation keeps one row and exposes failed result evidence", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    const call = turn.llm_calls[1];
    turn.execution_events = [
      makeExecutionEvent({
        event_id: "tool-start:failed-read",
        kind: "tool_start",
        subject_node_id: "toolu_read1",
        start: metric(call.start.value + 50),
      }),
      makeExecutionEvent({
        event_id: "tool-result:failed-read",
        kind: "tool_result",
        subject_node_id: "toolu_read1",
        start: metric(call.start.value + 100),
        success: false,
      }),
    ];
    await route.fulfill({ response, json: session });
  });

  await page.goto(nodeUrl("u1"));
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  const calls = dialog.getByRole("tabpanel");
  await openDisclosure(calls.getByTestId("workflow-calls"));
  const invocation = calls.getByTestId("tool-execution-u1-subject:toolu_read1");
  await expect(invocation).toHaveCount(1);
  await invocation.getByRole("button", { name: "Expand Read" }).click();
  const evidence = invocation.locator("xpath=following-sibling::tr[1]");
  await expect(evidence).toContainText("Failed");
  await expect(evidence.getByText("Source evidence", { exact: true })).toHaveCount(0);
  await expect(evidence.getByText("Requester", { exact: true })).toBeVisible();
});

test("phone child topics and artifact paths wrap without hiding navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const longTopic = `Investigate ${"topic-".repeat(30)}`;
  const longPath = `/home/user/demo/${"nested-directory-".repeat(20)}parser.ts`;
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    const agent = turn.children.find((child: { node_id: string }) => child.node_id === "toolu_agent1");
    agent.topic = longTopic;
    const read = turn.children.find((child: { node_id: string }) => child.node_id === "toolu_read1");
    read.tool.category = "edit";
    read.tool.paths = [longPath];
    read.tool.writes_file = false;
    await route.fulfill({ response, json: session });
  });

  await page.goto(nodeUrl("u1"));
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  const workflow = dialog.getByRole("tabpanel");
  await openDisclosure(workflow.getByTestId("workflow-children"));
  const agentRow = workflow.getByTestId("sub-agent-toolu_agent1");
  await expect(agentRow).toContainText(`${longTopic.slice(0, 99)}…`);
  await expect(agentRow.getByRole("link")).toHaveAttribute("title", longTopic);
  await expect
    .poll(() => agentRow.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(0);
  await agentRow.getByRole("link", { name: /Show details:/ }).click();
  await expect(page).toHaveURL(/node=toolu_agent1/);
  await page.goBack();

  await dialog.getByRole("tab", { name: "Content", exact: true }).click();
  const content = dialog.getByRole("tabpanel");
  await expect(content.getByTestId(`artifact-${longPath}`)).toContainText(`${longPath.slice(0, 99)}…`);
  await expect(content.getByTestId(`artifact-${longPath}`).getByRole("link")).toHaveAttribute("title", longPath);
  await expect
    .poll(() => content.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(0);
});
