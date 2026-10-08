// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "@playwright/test";
import type { SessionOut } from "../src/api/types";
import { makeExecutionEvent, makeNode, metric } from "../src/test/factories";
import {
  assertNoSelectionActionControls,
  consumeWorkflowDetailFailures,
  installDeepWorkflow,
  installWorkflowDetail,
  WORKFLOW_SESSION,
} from "./helpers/workflowFixture";

const sessionUrl = (query = "") => `/sessions/${encodeURIComponent(WORKFLOW_SESSION)}${query}`;

test("scope controls navigate independently and browser history restores whole session", async ({ page }) => {
  await installDeepWorkflow(page, 20);
  await page.goto(sessionUrl());
  await assertNoSelectionActionControls(page);
  await page.getByLabel("Activity filter").selectOption("running");
  await assertNoSelectionActionControls(page);
  await expect.poll(() => new URL(page.url()).searchParams.get("activity")).toBe("running");
  await page.getByRole("button", { name: "Expand matching paths" }).click();
  const contextRow = page.getByTestId("tree-row-deep-0");
  await expect(contextRow).toHaveAttribute("data-context-only", "true");
  await expect(contextRow).toHaveAttribute("data-selection", "none");
  await expect(contextRow).toContainText("Context ancestor");
  await expect(contextRow.locator("[data-workflow-status]")).toHaveCount(0);
  const deepRow = page.getByTestId("tree-row-deep-20");
  await expect(deepRow).toBeVisible();
  await expect(deepRow).toContainText("Inspect deep worker");
  await expect(deepRow.locator('[data-workflow-status="running"]')).toHaveText("RUNNING");
  await deepRow.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Focus subtree" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-20");
  await assertNoSelectionActionControls(page);
  await expect(page.getByRole("navigation", { name: "Workflow ancestry" })).toContainText("Delegate level 0");
  await expect(page.getByRole("navigation", { name: "Workflow ancestry" })).toContainText("Inspect deep worker");
  await page.getByLabel("Scope target").selectOption("deep-19");
  expect(new URL(page.url()).searchParams.get("scope")).toBe("deep-20");
  await page.getByRole("button", { name: "Focus subtree" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-19");
  await assertNoSelectionActionControls(page);
  await page.getByRole("button", { name: "Whole session" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has("scope")).toBe(false);
  await assertNoSelectionActionControls(page);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-19");
  await assertNoSelectionActionControls(page);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-20");
  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-19");
  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.has("scope")).toBe(false);
  await assertNoSelectionActionControls(page);
});

test("shows independent freshness labels and scopes agent membership to the focused subtree", async ({ page }) => {
  await installDeepWorkflow(page, 2, 0, true);
  await installWorkflowDetail(page, "resumed-outside");
  await page.goto(sessionUrl("?scope=deep-0"));
  await expect(page.getByText("Source updated", { exact: true })).toBeVisible();
  await expect(page.getByText("Fetched", { exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Latest observed activity" })).toBeVisible();
  await expect(page.locator('td [data-workflow-status="running"]').first()).toBeVisible();
  await expect(page.getByText("Complete-agent totals; session cost share")).toBeVisible();
  await expect(page.getByTestId("agent-summary-row-1")).toBeVisible();
  await expect(page.getByTestId("agent-summary-row-102")).toBeVisible();
  const resumedAgent = page.getByTestId("agent-summary-row-202");
  await expect(resumedAgent).toContainText("Earlier resumed work");
  await expect(resumedAgent).toContainText("36");
  await expect(resumedAgent).toContainText("$5.00");
  const completeAgentCost = await resumedAgent.getByRole("cell").nth(8).innerText();
  await resumedAgent.getByRole("link", { name: /Inspect LLM call 1/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("resumed-outside");
  await page.getByRole("button", { name: "Close details" }).click();
  await page.getByRole("switch", { name: "Agents in focused subtree" }).check();
  await expect(page.getByTestId("agent-summary-row-1")).toHaveCount(0);
  await expect(page.getByTestId("agent-summary-row-2")).toHaveCount(0);
  await expect(page.getByTestId("agent-summary-row-102")).toBeVisible();
  await expect(resumedAgent).toBeVisible();
  await expect(resumedAgent).toContainText("36");
  await expect(resumedAgent).toContainText("$5.00");
  await expect(resumedAgent.getByRole("cell").nth(8)).toHaveText(completeAgentCost);
  await resumedAgent.getByRole("link", { name: /Inspect LLM call 1/ }).click();
  await expect
    .poll(() => {
      const query = new URL(page.url()).searchParams;
      return [query.get("node"), query.get("tab"), query.get("sel"), query.get("scope")].join("|");
    })
    .toBe("resumed-outside|workflow|call|deep-0");
});

test("hierarchy context menu focuses a subtree without inspecting it", async ({ page }) => {
  await installDeepWorkflow(page, 6);
  await page.goto(sessionUrl());
  await page.getByTestId("tree-row-u1").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Focus subtree" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("u1");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("tree-row-u1")).toBeVisible();
});

test("drawer ancestry links inspect the selected ancestor and retain parent navigation", async ({ page }) => {
  await installDeepWorkflow(page, 6);
  await installWorkflowDetail(page, "deep-6");
  await page.goto(sessionUrl("?node=deep-6"));
  await expect(page.getByRole("navigation", { name: "Inspected ancestry" })).toContainText("Delegate level 0");
  await expect(page.getByRole("tabpanel", { name: "Overview" }).getByText("Recorded task for deep-6")).toBeVisible();
  await expect(page.getByRole("button", { name: "To parent" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Inspected ancestry" })
    .locator('[data-node-id="session"]')
    .getByRole("link")
    .click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("session");
});

test("unexpected synthetic node detail requests fail with an explicit fixture error", async ({ page }) => {
  await installDeepWorkflow(page, 2);
  await page.goto(sessionUrl());
  await expect(page.getByTestId("tree-row-session")).toBeVisible();
  const detailPath = `/api/sessions/${encodeURIComponent(WORKFLOW_SESSION)}/nodes/deep-999`;
  const requestFailed = page.waitForEvent("requestfailed", (request) => request.url().includes("/nodes/deep-999"));
  await page.evaluate(async (path) => {
    await fetch(path).catch(() => undefined);
  }, detailPath);
  await requestFailed;
  expect(consumeWorkflowDetailFailures(page)).toEqual([
    'Unexpected synthetic node detail request "deep-999". Install installWorkflowDetail(page, "deep-999") in this test.',
  ]);
});

test("unexpected detail requests for transformed synthetic nodes fail while native nodes remain fetchable", async ({
  page,
}) => {
  await installDeepWorkflow(page, 2, 0, false, (session) => {
    session.root.children.push(makeNode({ node_id: "live-first", kind: "turn", topic: "Injected live row" }));
  });
  await page.goto(sessionUrl());
  await expect(page.getByTestId("tree-row-live-first")).toBeVisible();

  const nativeResponsePromise = page.waitForResponse(
    (response) => response.url().includes(`/nodes/u1`) && response.request().method() === "GET",
  );
  await page.evaluate(async (path) => fetch(path), `/api/sessions/${encodeURIComponent(WORKFLOW_SESSION)}/nodes/u1`);
  const nativeResponse = await nativeResponsePromise;
  expect(nativeResponse.ok()).toBe(true);

  const detailPath = `/api/sessions/${encodeURIComponent(WORKFLOW_SESSION)}/nodes/live-first`;
  const requestFailed = page.waitForEvent("requestfailed", (request) => request.url().includes("/nodes/live-first"));
  await page.evaluate(async (path) => {
    await fetch(path).catch(() => undefined);
  }, detailPath);
  await requestFailed;
  expect(consumeWorkflowDetailFailures(page)).toEqual([
    'Unexpected synthetic node detail request "live-first". Install installWorkflowDetail(page, "live-first") in this test.',
  ]);
});

test("marking a workflow row preserves scope, activity and inspection", async ({ page }) => {
  await installDeepWorkflow(page, 2);
  await page.goto(sessionUrl("?scope=u1&activity=running&node=u1&tab=overview&sel=node&entity=u1"));
  await page.getByRole("button", { name: "Close details" }).click();
  const row = page.getByTestId("tree-row-u1");
  await row.click();
  const query = new URL(page.url()).searchParams;
  expect(query.get("scope")).toBe("u1");
  expect(query.get("activity")).toBe("running");
  expect(query.get("node")).toBeNull();
  expect(query.get("tab")).toBeNull();
  expect(query.get("sel")).toBe("node");
  expect(query.get("entity")).toBe("u1");
});

test("passively notes a resolved selection outside the focused scope", async ({ page }) => {
  await installDeepWorkflow(page, 6);
  await installWorkflowDetail(page, "deep-6");
  await page.goto(sessionUrl("?scope=deep-6&activity=running&node=deep-6&sel=node&entity=u1"));
  await page.getByRole("button", { name: "Close details" }).click();
  await expect(page.getByText("Selected item is outside this workflow scope or filter")).toBeVisible();
  const query = new URL(page.url()).searchParams;
  expect(query.get("scope")).toBe("deep-6");
  expect(query.get("activity")).toBe("running");
  expect(query.get("entity")).toBe("u1");
});

test("does not note a collapsed selection still visible to the workflow filter", async ({ page }) => {
  await installDeepWorkflow(page, 6);
  await page.goto(sessionUrl("?scope=deep-0&activity=running&sel=node&entity=deep-6"));
  await assertNoSelectionActionControls(page);
  await expect(page.getByTestId("tree-row-deep-0")).toBeVisible();
  await expect(page.getByTestId("tree-row-deep-6")).toHaveCount(0);
  await expect(page.getByText("Selected item is outside this workflow scope or filter")).toHaveCount(0);
});

test("unresolved selections keep only the unavailable notice", async ({ page }) => {
  await installDeepWorkflow(page, 2);
  await page.goto(sessionUrl("?scope=deep-0&sel=node&entity=missing-node"));
  await assertNoSelectionActionControls(page);
  await expect(page.getByText("Selected item unavailable")).toBeVisible();
  await expect(page.getByText("Selected item is outside this workflow scope or filter")).toHaveCount(0);
});

test("invalid scope and activity stay in the URL until explicit recovery", async ({ page }) => {
  await installDeepWorkflow(page, 2);
  await page.goto(sessionUrl("?scope=missing&activity=imaginary"));
  await assertNoSelectionActionControls(page);
  await expect(page.getByText("Workflow scope unavailable; showing the whole session")).toBeVisible();
  await expect(page.getByText("Activity filter unavailable; showing all activity")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("scope")).toBe("missing");
  expect(new URL(page.url()).searchParams.get("activity")).toBe("imaginary");
  await page.getByRole("button", { name: "Whole session" }).click();
  await page.getByLabel("Activity filter").selectOption("all");
  await assertNoSelectionActionControls(page);
  await expect.poll(() => new URL(page.url()).searchParams.has("scope")).toBe(false);
  await expect.poll(() => new URL(page.url()).searchParams.has("activity")).toBe(false);
});

test("renders recorded owner completion separately from child, tool, resume and untimed evidence", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installDeepWorkflow(page, 1);
  await page.route(`**/api/sessions/${encodeURIComponent(WORKFLOW_SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    session.root.children.push(
      makeNode({
        node_id: "state-completed",
        kind: "agent",
        agent_id: 301,
        topic: "Own completion",
        execution_events: [
          makeExecutionEvent({
            kind: "completion",
            success: true,
            start: metric(10),
            subject_node_id: "state-completed",
          }),
        ],
      }),
      makeNode({
        node_id: "state-failed",
        kind: "agent",
        agent_id: 302,
        topic: "Own failure",
        execution_events: [
          makeExecutionEvent({
            kind: "completion",
            success: false,
            start: metric(20),
            subject_node_id: "state-failed",
          }),
        ],
      }),
      makeNode({
        node_id: "state-child-completion",
        kind: "agent",
        agent_id: 303,
        topic: "Child completion only",
        activity: "running",
        execution_events: [makeExecutionEvent({ kind: "child_completion", success: true, start: metric(30) })],
      }),
      makeNode({
        node_id: "state-tool-failure",
        kind: "agent",
        agent_id: 304,
        topic: "Tool failure only",
        activity: "waiting",
        execution_events: [makeExecutionEvent({ kind: "tool_result", success: false, start: metric(40) })],
      }),
      makeNode({
        node_id: "state-untimed-completion",
        kind: "agent",
        agent_id: 305,
        topic: "Untimed own completion",
        execution_events: [
          makeExecutionEvent({ kind: "completion", success: true, subject_node_id: "state-untimed-completion" }),
        ],
      }),
      makeNode({
        node_id: "state-resume-old",
        kind: "agent",
        agent_id: 306,
        topic: "Old completed task",
        execution_events: [
          makeExecutionEvent({
            kind: "completion",
            success: true,
            source_stream_id: "state-resume",
            source_order: 1,
          }),
        ],
      }),
      makeNode({
        node_id: "state-resume-latest",
        kind: "agent",
        agent_id: 306,
        topic: "Resumed task",
        execution_events: [makeExecutionEvent({ kind: "resume", source_stream_id: "state-resume", source_order: 2 })],
      }),
      makeNode({
        node_id: "state-incomparable",
        kind: "agent",
        agent_id: 307,
        topic: "Incomparable observations",
        activity: "running",
        execution_events: [
          makeExecutionEvent({ kind: "resume", start: metric(50), source_stream_id: "state-a" }),
          makeExecutionEvent({ kind: "resume", start: metric(50), source_stream_id: "state-b" }),
        ],
      }),
    );
    await route.fulfill({ response, json: session });
  });
  await installWorkflowDetail(page, "state-untimed-completion");
  await page.goto(sessionUrl());

  await expect(page.getByTestId("tree-row-state-completed").locator('[data-workflow-status="completed"]')).toHaveText(
    "COMPLETED",
  );
  await expect(page.getByTestId("tree-row-state-failed").locator('[data-workflow-status="failed"]')).toHaveText(
    "FAILED",
  );
  await expect(
    page.getByTestId("tree-row-state-child-completion").locator('[data-workflow-status="running"]'),
  ).toHaveText("RUNNING");
  await expect(page.getByTestId("tree-row-state-tool-failure").locator('[data-workflow-status="waiting"]')).toHaveText(
    "WAITING",
  );
  await expect(
    page.getByTestId("tree-row-state-untimed-completion").locator('[data-workflow-status="completed"]'),
  ).toHaveText("COMPLETED");
  await expect(page.getByTestId("tree-row-state-resume-latest").locator("[data-workflow-status]")).toHaveCount(0);
  await expect(page.getByTestId("tree-row-state-resume-old").locator('[data-workflow-status="completed"]')).toHaveText(
    "COMPLETED",
  );
  await expect(page.getByTestId("tree-row-state-incomparable").locator("[data-workflow-status]")).toHaveCount(0);

  await page
    .getByTestId("tree-row-state-untimed-completion")
    .getByRole("link", { name: /Show details:/ })
    .click();
  await expect(page.getByRole("tabpanel", { name: "Overview" })).toContainText(
    "Recorded task for state-untimed-completion",
  );
  await page.getByRole("button", { name: "Close details" }).click();

  const summaryTab = page.getByTestId("bottom-tab-agent-summary");
  if ((await summaryTab.getAttribute("aria-expanded")) !== "true") await summaryTab.click();
  const splitter = page.getByRole("separator", { name: "Resize tree and bottom panel" });
  await splitter.focus();
  for (let index = 0; index < 30; index += 1) await page.keyboard.press("ArrowUp");
  for (const [agentId, status, label] of [
    [301, "completed", "COMPLETED"],
    [303, "running", "RUNNING"],
    [304, "waiting", "WAITING"],
  ] as const) {
    const capsule = page.getByTestId(`agent-summary-row-${agentId}`).locator(`[data-workflow-status="${status}"]`);
    await expect(capsule).toHaveText(label);
    const textBounds = await capsule.locator(".mantine-Badge-label").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return {
        clientWidth: element.clientWidth,
        textWidth: range.getBoundingClientRect().width,
      };
    });
    expect(textBounds.textWidth).toBeLessThanOrEqual(textBounds.clientWidth + 1);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const resumed = page.getByTestId("agent-summary-card-306");
  await expect(resumed.locator("[data-workflow-status]")).toHaveCount(0);
  await expect(resumed).not.toContainText("Workflow status");
  await expect(resumed).toContainText("Resumed task");
  await assertNoSelectionActionControls(page);
});
