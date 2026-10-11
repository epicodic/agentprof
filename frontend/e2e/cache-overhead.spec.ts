// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, type Page, test } from "@playwright/test";
import type { FindingOut } from "../src/api/types";
import {
  cost,
  makeCall,
  makeExecutionEvent,
  makeNode,
  makeSession,
  makeSummary,
  metric,
  tokens,
} from "../src/test/factories";
import { assertNoSelectionActionControls, installDeepWorkflow, WORKFLOW_SESSION } from "./helpers/workflowFixture";
import { workflowStream } from "./helpers/workflowStream";

const url = `/sessions/${encodeURIComponent(WORKFLOW_SESSION)}?node=u1`;

async function cacheFixture(page: Page, revision: () => number = () => 0): Promise<void> {
  await installDeepWorkflow(page, 20, 30, false, (session) => {
    session.mtime += revision();
    const owner = session.root.children.find((child) => child.node_id === "u1");
    if (owner === undefined) throw new Error("Missing public fixture owner");
    const start = owner.start.value ?? 0;
    owner.llm_calls = [
      makeCall({
        call_id: "warm",
        start: metric(start + 1),
        tokens: {
          ...tokens(100, 10),
          cache_read: metric(1000 + revision() * 1000),
          cache_write: metric(0),
          cache_write_5m: metric(0),
          cache_write_1h: metric(0),
        },
        cost: cost(0.1, "USD", "estimated"),
      }),
      makeCall({
        call_id: "rewrite",
        start: metric(start + 600001),
        tokens: {
          ...tokens(200, 20),
          cache_read: metric(0),
          cache_write: metric(100000),
          cache_write_5m: metric(60000),
          cache_write_1h: metric(40000),
        },
        cost: cost(1, "USD", "estimated"),
        cost_parts: {
          cache_read: cost(0, "USD", "estimated"),
          cache_write_5m: cost(0.3, "USD", "estimated"),
          cache_write_1h: cost(0.4, "USD", "estimated"),
        },
        cold_rewrite: true,
        gap: metric(600000, "estimated"),
        gap_basis: "previous_start",
      }),
    ];
    owner.execution_events ??= [];
    owner.execution_events.push(
      makeExecutionEvent({ kind: "compaction", event_id: "compact", start: metric(start + 500000) }),
    );
    const reference = { kind: "call" as const, owner_id: "u1", key: "id:rewrite", label: "LLM call 2" };
    const finding = (
      heuristic: string,
      message: string,
      references: NonNullable<FindingOut["references"]>,
    ): FindingOut => ({
      heuristic_id: heuristic,
      node_id: "u1",
      severity: "low",
      message,
      evidence: { gap_ms: 600000, cache_write_tokens: 100000 },
      estimated_avoidable_cost: cost(),
      observed_cost: cost(0.7, "USD", "estimated"),
      avoidable_cost_baseline: null,
      references,
    });
    owner.findings = [
      finding("E1", "Large cache rewrite with little cache reuse", [reference]),
      finding("E6", "Long interval between model calls", [
        { ...reference, key: "id:warm", label: "LLM call 1" },
        reference,
      ]),
      finding("E7", "Context compaction observed", [
        { kind: "event", owner_id: "u1", key: "compact", label: "Compaction event" },
        reference,
      ]),
      finding("W5", "Consecutive polling calls", [
        { kind: "node", owner_id: "toolu_read1", key: "toolu_read1", label: "Recorded tool" },
      ]),
    ];
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`cache quantities and exact evidence navigation at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await cacheFixture(page);
    await page.goto(url);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("cache-analysis")).toBeVisible();
    await expect(dialog.getByTestId("cache-analysis")).toContainText("Cache read");
    await expect(dialog.getByTestId("cache-analysis")).toContainText("Cache write");
    await expect(dialog.getByTestId("cache-analysis")).toContainText("5m");
    await expect(dialog.getByTestId("cache-analysis")).toContainText("1h");
    await dialog.getByTestId("cache-analysis").getByRole("heading").scrollIntoViewIfNeeded();
    await dialog
      .getByTestId("cache-analysis")
      .screenshot({ path: test.info().outputPath(`cache-overview-${viewport.width}.png`) });
    await expect(dialog.getByTestId("cache-value-cache_write_total-own")).toHaveCSS("white-space", "nowrap");
    await dialog.getByRole("button", { name: "Expand E1 findings" }).click();
    const rewrite = dialog.getByTestId("finding-group-E1");
    await expect(rewrite).toContainText("Observed");
    await expect(rewrite).not.toContainText("Estimated avoidable cost:");
    const link = rewrite.getByRole("link", { name: "Show details: LLM call 2" });
    await expect(link).toHaveAttribute("href", /call=id%3Arewrite/);
    await link.click();
    await expect(page).toHaveURL(/call=id%3Arewrite/);
    await expect(dialog.getByRole("tab", { name: "Workflow" })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByTestId("call-cost-u1-1")).toHaveAttribute("data-selection", "exact");
    await page.goBack();
    await expect(dialog.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    await dialog.getByRole("button", { name: "Expand E6 findings" }).click();
    await dialog.getByTestId("finding-group-E6").getByRole("link", { name: "Show details: LLM call 1" }).click();
    await expect(page).toHaveURL(/call=id%3Awarm/);
    await expect(dialog.getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "exact");
    await page.goBack();
    await dialog.getByRole("button", { name: "Expand E7 findings" }).click();
    await dialog.getByTestId("finding-group-E7").getByRole("link", { name: "Show details: Compaction event" }).click();
    await expect(page).toHaveURL(/event=compact/);
    await page.goBack();
    await dialog.getByRole("button", { name: "Expand W5 findings" }).click();
    await dialog.getByTestId("finding-group-W5").getByRole("link", { name: "Show details: Recorded tool" }).click();
    await expect(page).toHaveURL(/node=toolu_read1/);
    await expect(dialog).toContainText("Read");
    await assertNoSelectionActionControls(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`cache overview retains reading and exact selection on live update at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const stream = await workflowStream();
    let revision = 0;
    try {
      await cacheFixture(page, () => revision);
      await page.route("**/api/sessions/events", (route) => route.continue({ url: stream.url }));
      await page.goto(`${url}&sel=call&owner=u1&call=id%3Arewrite`);
      await expect(page.getByRole("dialog").getByTestId("cache-analysis")).toBeVisible();
      await stream.connected;
      const panel = page.getByRole("tabpanel", { name: "Overview" });
      await panel.evaluate((element) => {
        element.scrollTop = 180;
      });
      const scroll = await panel.evaluate((element) => element.scrollTop);
      const response = await page.request.get(`/api/sessions/${encodeURIComponent(WORKFLOW_SESSION)}`);
      const native = await response.json();
      revision = 1;
      const updated = page.waitForResponse(
        (candidate) => new URL(candidate.url()).pathname === `/api/sessions/${encodeURIComponent(WORKFLOW_SESSION)}`,
      );
      stream.emit(makeSummary({ id: WORKFLOW_SESSION, mtime: native.mtime + revision }));
      await updated;
      await expect(
        panel.getByTestId("cache-analysis").getByRole("row").filter({ hasText: "Cache read" }).first(),
      ).toContainText("2.0k");
      await expect(page).toHaveURL(/call=id%3Arewrite/);
      await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(scroll);
      await expect(page.getByRole("dialog").getByTestId("cache-analysis")).toBeAttached();
    } finally {
      await stream.close();
    }
  });
}

for (const agent of ["claude-code", "codex", "copilot-vscode"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`${agent} cache measurement and billing distinctions at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const id = `${agent}:cache-example`;
      const isCopilot = agent === "copilot-vscode";
      const nodeCost = isCopilot
        ? cost(42, "credits", "exact", 0.42)
        : cost(1, "USD", agent === "codex" ? "estimated" : "exact");
      const call = makeCall({
        call_id: "source-call",
        start: metric(1000),
        tokens: {
          ...tokens(100, 10),
          cache_read: metric(12000),
          cache_write: metric(isCopilot ? null : 500),
          cache_write_5m: metric(agent === "claude-code" ? 500 : null),
          cache_write_1h: metric(agent === "claude-code" ? 0 : null),
        },
        cost: isCopilot ? cost(2, "credits", "exact", 0.02) : cost(0.1, "USD", "estimated"),
        cost_parts: isCopilot
          ? {}
          : {
              cache_read: cost(0.01, "USD", "estimated"),
              cache_write_5m: agent === "claude-code" ? cost(0.03, "USD", "estimated") : cost(),
              cache_write_1h: agent === "claude-code" ? cost(0, "USD", "estimated") : cost(),
            },
      });
      const owner = makeNode({
        node_id: "own",
        kind: "turn",
        start: metric(0),
        end: metric(2000),
        llm_calls: [call],
        cost_own: nodeCost,
        cost_total: nodeCost,
      });
      const root = makeNode({
        node_id: "session",
        kind: "session",
        start: metric(0),
        end: metric(2000),
        children: [owner],
        cost_total: nodeCost,
      });
      const session = { ...makeSession(root), id, agent };
      await page.route(`**/api/sessions/${encodeURIComponent(id)}`, (route) => route.fulfill({ json: session }));
      await page.route(`**/api/sessions/${encodeURIComponent(id)}/nodes/own`, (route) =>
        route.fulfill({
          json: { node_id: "own", prompt: "Synthetic task", result: "Synthetic result", arguments: {} },
        }),
      );
      await page.goto(`/sessions/${encodeURIComponent(id)}?node=own`);
      const section = page.getByRole("dialog").getByTestId("cache-analysis");
      await expect(section).toBeVisible();
      await expect(section).toContainText("12.0k");
      if (isCopilot) {
        await expect(section).toContainText("credits");
        await expect(section).toContainText("42.0 cr");
        await expect(section).toContainText("2.00 cr");
        await expect(section.getByRole("row").filter({ hasText: "Cache write" }).first()).toContainText("–");
      } else if (agent === "codex") {
        await expect(section).toContainText("API-equivalent");
        await expect(section.getByRole("row").filter({ hasText: "5m" }).first()).toContainText("–");
      } else {
        await expect(section).toContainText("pricing estimate");
        await expect(section.getByRole("row").filter({ hasText: "5m" }).first()).toContainText("500");
      }
      await section.getByRole("heading").scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`cache-${agent}-${viewport.width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`session finding evidence opens exact details and dismisses findings at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await cacheFixture(page);
    await page.goto(`/sessions/${encodeURIComponent(WORKFLOW_SESSION)}`);
    await page.getByRole("button", { name: /^Findings \(/ }).click();
    const findings = page.getByRole("table", { name: "Session findings" });
    await expect(findings).toBeVisible();
    const rewrite = findings.getByTestId("finding-E1-u1");
    await rewrite.getByRole("button", { name: "Expand evidence" }).click();
    await expect(rewrite).toContainText('"gap_ms": 600000');
    await expect(rewrite).toContainText('"cache_write_tokens": 100000');
    await rewrite.getByRole("link", { name: "Show details: LLM call 2" }).click();
    await expect(page).toHaveURL(/call=id%3Arewrite/);
    await expect(findings).not.toBeVisible();
    await expect(page.getByRole("dialog").getByTestId("call-cost-u1-1")).toHaveAttribute("data-selection", "exact");
  });
}
