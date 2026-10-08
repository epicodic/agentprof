// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "@playwright/test";

const SESSION = "claude-code:11111111-1111-4111-8111-111111111111";

for (const width of [1280, 390]) {
  test(`merged drawer layout and synchronized charts at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1`);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("metrics-tokens")).toBeVisible();
    await expect(dialog.locator("summary", { hasText: "Metric details" })).toHaveCount(0);
    await expect(dialog.getByRole("tab")).toHaveText(["Overview", "Workflow", "Content"]);
    await expect(dialog.getByRole("tabpanel", { name: "Overview" }).getByTestId("context-chart")).toHaveCount(0);
    await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
    const panel = dialog.getByRole("tabpanel", { name: "Workflow" });
    const surface = panel.getByTestId("workflow-charts");
    await expect(surface).toBeVisible();
    for (const [sectionId, unit] of [
      ["cost-section", "USD per call"],
      ["context-section", "Tokens"],
    ]) {
      const section = surface.getByTestId(sectionId);
      await expect(section.getByText(unit, { exact: true })).toBeVisible();
      const labels = section.getByTestId("chart-value-label");
      await expect(labels.first()).toHaveText(sectionId === "cost-section" ? /^\$0(?:\.0+)?$/ : "0");
      const guides = section.getByTestId("chart-value-guide");
      expect(await guides.count()).toBeGreaterThanOrEqual(2);
      expect(await guides.count()).toBeLessThanOrEqual(4);
      await expect(labels).toHaveCount((await guides.count()) + 1);
      for (const guide of await guides.all()) {
        await expect(guide).toBeVisible();
        expect(await guide.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
      }
    }
    await expect(surface.getByTestId("context-section").getByTestId("chart-time-axis")).toHaveText(
      (await surface.getByTestId("cost-section").getByTestId("chart-time-axis").textContent()) ?? "",
    );
    const track = surface.getByTestId("track-u1");
    const cost = surface.getByTestId("cost-chart");
    const context = surface.getByTestId("context-chart");
    const bounds = await Promise.all([track, cost, context].map((plot) => plot.boundingBox()));
    const [timelineBox, costBox, contextBox] = bounds;
    if (!timelineBox || !costBox || !contextBox) throw new Error("Missing chart bounds");
    expect(timelineBox.y).toBeLessThan(costBox.y);
    expect(costBox.y).toBeLessThan(contextBox.y);
    for (const box of [costBox, contextBox]) {
      expect(Math.abs(box.x - timelineBox.x)).toBeLessThan(1);
      expect(Math.abs(box.width - timelineBox.width)).toBeLessThan(1);
    }
    await expect(panel.getByTestId("workflow-children")).toHaveAttribute("open");
    await expect(
      panel.getByTestId("workflow-children").getByRole("heading", { name: "Sub-agents", exact: true }),
    ).toHaveCount(0);
    await expect(panel.getByTestId("workflow-calls").getByText("LLM calls", { exact: true })).toHaveCount(1);
    await expect(panel.getByTestId("workflow-calls")).toHaveAttribute("open");
    await panel.getByTestId("workflow-calls").locator("summary").click();
    const costBar = surface.getByTestId("cost-bar-u1-0");
    const contextBar = surface.getByTestId("context-bar-u1-0");
    const costPosition = await costBar.boundingBox();
    const contextPosition = await contextBar.boundingBox();
    if (!costPosition || !contextPosition) throw new Error("Missing timed call bars");
    expect(Math.abs(costPosition.x - contextPosition.x)).toBeLessThan(1);
    await costBar.click();
    await expect(panel.getByTestId("workflow-calls")).not.toHaveAttribute("open");
    if (width === 390) {
      await surface.evaluate((element) => {
        element.scrollLeft = 80;
      });
      const shifted = await Promise.all([track, cost, context].map((plot) => plot.boundingBox()));
      expect(await surface.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      const shiftedTimeline = shifted[0];
      if (!shiftedTimeline) throw new Error("Missing scrolled timeline");
      for (const box of shifted) {
        if (!box) throw new Error("Missing scrolled chart");
        expect(Math.abs(box.x - shiftedTimeline.x)).toBeLessThan(1);
      }
      await surface.evaluate((element) => {
        element.scrollLeft = 0;
      });
    }
    await panel.getByTestId("expand-calls-toolu_agent1").click();
    await expect(panel.getByTestId("sub-agent-toolu_agent2")).toBeVisible();
    await panel.getByTestId("workflow-children").locator("summary").first().click();
    await panel.getByTestId("workflow-calls").locator("summary").click();
    await expect(panel.getByRole("button", { name: "Expand LLM call 1", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("workflow.png"), fullPage: true });
  });
}

test("legacy Calls deep links reveal calls in Workflow", async ({ page }) => {
  const session = await (await page.request.get(`/api/sessions/${encodeURIComponent(SESSION)}`)).json();
  const call = session.root.children.find((node: { node_id: string }) => node.node_id === "u1").llm_calls[0];
  const key = call.call_id === null ? `time:${call.start.value}` : `id:${call.call_id}`;
  await page.goto(
    `/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=calls&sel=call&owner=u1&call=${encodeURIComponent(key)}`,
  );
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "Workflow", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByTestId("workflow-calls")).toHaveAttribute("open");
});

test("round-value axes keep small dollar amounts distinct and show readable token labels", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((node: { node_id: string }) => node.node_id === "u1");
    const call = turn.llm_calls[0];
    call.cost = { value: 0.000024, usd: 0.000024, unit: "USD", provenance: "exact" };
    call.tokens.input.value = 35000;
    call.tokens.cache_read.value = 0;
    call.tokens.cache_write.value = 0;
    call.in_context = true;
    turn.llm_calls = [call];
    await route.fulfill({ response, json: session });
  });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  const surface = page.getByTestId("workflow-charts");
  const cost = surface.getByTestId("cost-section");
  const context = surface.getByTestId("context-section");
  await expect(cost.getByTestId("chart-value-label")).toHaveText(["$0.00000", "$0.00001", "$0.00002", "$0.00003"]);
  await expect(context.getByTestId("chart-value-label")).toHaveText(["0", "20.0k", "40.0k"]);
  await expect(cost.getByTestId("chart-value-guide")).toHaveCount(3);
  await expect(context.getByTestId("chart-value-guide")).toHaveCount(2);
});

test("remembers disclosures through tabs and history and reopens calls for explicit inspection", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  const dialog = page.getByRole("dialog");
  const calls = dialog.getByTestId("workflow-calls");
  await expect(calls).toHaveAttribute("open");
  await calls.getByRole("button", { name: "Expand LLM call 1", exact: true }).click();
  await dialog.getByRole("tab", { name: "Content", exact: true }).click();
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await expect(calls).toHaveAttribute("open");
  await expect(calls.getByRole("button", { name: "Collapse LLM call 1", exact: true })).toBeVisible();
  await dialog.getByTestId("node-timeline").getByRole("link", { name: "Show details: Investigate tests" }).click();
  await page.goBack();
  await expect(calls).toHaveAttribute("open");
  await expect(calls.getByRole("button", { name: "Collapse LLM call 1", exact: true })).toBeVisible();
  await calls.locator("summary").click();
  await dialog.getByTestId("cost-bar-u1-0").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Show details:.*LLM call 1/ }).click();
  await expect(calls).toHaveAttribute("open");
});

test("charts share recorded call timestamps when node timing is unavailable", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((node: { node_id: string }) => node.node_id === "u1");
    turn.start = { value: null, provenance: "n/a" };
    turn.end = { value: null, provenance: "n/a" };
    turn.llm_calls[0].duration = { value: null, provenance: "n/a" };
    await route.fulfill({ response, json: session });
  });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  const surface = page.getByTestId("workflow-charts");
  const positions = await Promise.all(
    [
      surface.getByTestId("timeline-call-tick-u1-0"),
      surface.getByTestId("cost-bar-u1-0"),
      surface.getByTestId("context-bar-u1-0"),
    ].map((mark) => mark.boundingBox()),
  );
  const first = positions[0];
  if (!first) throw new Error("Missing timeline timestamp");
  for (const position of positions) {
    if (!position) throw new Error("Missing plotted timestamp");
    expect(Math.abs(position.x - first.x)).toBeLessThan(1);
  }
});
