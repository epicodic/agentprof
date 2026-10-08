// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, type Locator, type Page, test } from "@playwright/test";
import { makeExecutionEvent, metric } from "../src/test/factories";

const SESSION = "claude-code:11111111-1111-4111-8111-111111111111";

async function openDisclosure(disclosure: Locator): Promise<void> {
  if ((await disclosure.getAttribute("open")) === null) await disclosure.locator("summary").click();
}

async function expectNodeParam(page: Page, nodeId: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe(nodeId);
}

test("browse the fixture session from the list", async ({ page }) => {
  await page.goto("/");
  const headers = page.locator("thead th");
  await expect(headers.nth(3)).toHaveText("Last activity ▼");
  await expect(headers.nth(4)).toHaveText("Start");
  const row = page.getByTestId(`session-row-${SESSION}`);
  await expect(row).toContainText("Fix the parser");
  await expect(row.locator("td").nth(3)).not.toHaveText("–");

  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/sessions\/claude-code%3A11111111/);
  await expect(page.getByTestId("tree-row-u1")).toBeVisible();
  await expect(
    page.getByRole("grid", { name: "Call tree" }).getByRole("columnheader", { name: "Agent" }),
  ).toBeVisible();
  await expect(page.getByTestId("tree-agent-session")).toHaveText("1");
  await expect(page.getByTestId("tree-agent-toolu_agent1")).toHaveText("2");
  await expect(page.getByTestId("tree-row-toolu_read1")).toHaveCount(0);
  await expect(page.getByTestId("track-u1")).toBeVisible();
  await expect(page.getByTestId("context-u1")).not.toHaveText("–");

  await expect(page.getByTestId("tree-row-toolu_agent2")).toHaveCount(0);
  await page.getByTestId("toggle-toolu_agent1").click();
  await expect(page.getByTestId("tree-row-toolu_agent2")).toBeVisible();
  await expect(page.getByTestId("tree-row-toolu_grep1")).toHaveCount(0);

  await page.getByRole("button", { name: /Findings \(\d+\)/ }).click();
  const finding = page.getByTestId("finding-W4-u2");
  await finding.click();
  await expect(finding).toHaveAttribute("data-selection", "local");
  await expect(page.getByTestId("tree-row-u2")).toHaveAttribute("aria-selected", "false");
  await finding.getByRole("link", { name: /Show details:/ }).click();
  await expectNodeParam(page, "u2");
  await expect(page.getByTestId("tree-row-u2")).toHaveAttribute("data-inspected", "true");
});

test("open a session by URL", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await expect(page.getByRole("heading", { name: "Fix the parser" })).toBeVisible();
  await expect(page.getByTestId("tree-row-u2")).toBeVisible();
  await expect(page.getByTestId("bottom-tab-agent-summary")).toBeVisible();
  await expect(page.getByTestId("agent-summary-row-1")).toBeVisible();
});

test("collapses and restores the agent summary from its active tab", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  const tab = page.getByRole("button", { name: "Agent summary" });
  await expect(tab).toHaveAttribute("aria-expanded", "true");
  await tab.click();
  await expect(page.getByTestId("agent-summary-table")).toBeHidden();
  await expect(page.getByTestId("session-workspace")).toHaveAttribute("data-bottom-open", "false");
  await expect(tab).toHaveAttribute("aria-expanded", "false");

  await tab.click();
  await expect(page.getByTestId("agent-summary-table")).toBeVisible();
  await expect(page.getByTestId("session-workspace")).toHaveAttribute("data-bottom-open", "true");
});

test("persists a keyboard splitter adjustment after reload", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  const splitter = page.getByRole("separator", { name: "Resize tree and bottom panel" });
  await expect(splitter).toHaveAttribute("aria-valuenow", "75");
  await splitter.focus();
  await page.keyboard.press("ArrowUp");
  await expect(splitter).toHaveAttribute("aria-valuenow", "74");

  await page.reload();
  await expect(page.getByRole("separator", { name: "Resize tree and bottom panel" })).toHaveAttribute(
    "aria-valuenow",
    "74",
  );
});

test("resizes the tree through the splitter drag handle", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  const splitter = page.getByRole("separator", { name: "Resize tree and bottom panel" });
  const splitterBox = await splitter.boundingBox();
  const workspaceBox = await page.getByTestId("session-workspace").boundingBox();
  if (splitterBox === null || workspaceBox === null) throw new Error("splitter workspace is not visible");

  const targetY = workspaceBox.y + workspaceBox.height * 0.65;
  await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + splitterBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitterBox.x + splitterBox.width / 2, targetY, { steps: 5 });
  await page.mouse.up();

  await expect(splitter).toHaveAttribute("aria-valuenow", "65");
});

test("show a turn's timeline, sub-agents and tools in its detail drawer", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    const call = turn.llm_calls[1];
    call.source_request_id = "read-request";
    call.preceding_events = [
      {
        kind: "tool",
        event_id: "toolu_read1",
        start: call.start,
        end: metric(call.start.value + 50),
        duration: metric(50),
      },
    ];
    turn.execution_events = [
      makeExecutionEvent({
        event_id: "tool-start:read-invocation",
        kind: "tool_start",
        subject_node_id: "toolu_read1",
        start: metric(call.start.value + 50),
        links: [
          { owner_id: "u1", source_request_id: call.source_request_id, relation: "requested_by", evidence: "recorded" },
        ],
      }),
      makeExecutionEvent({
        event_id: "tool-result:read-invocation",
        kind: "tool_result",
        subject_node_id: "toolu_read1",
        start: metric(call.start.value + 100),
        links: [
          { owner_id: "u1", source_request_id: call.source_request_id, relation: "requested_by", evidence: "recorded" },
        ],
      }),
    ];
    await route.fulfill({ response, json: session });
  });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await page.getByTestId("tree-row-u1").getByRole("link", { name: "Show details: Fix the parser" }).click();
  const dialog = page.getByRole("dialog");
  const overview = dialog.getByRole("tabpanel");
  await expect(overview.getByTestId("metrics-cost-own")).toBeVisible();
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  const workflow = dialog.getByRole("tabpanel");
  await expect(workflow.getByTestId("context-section")).toBeVisible();
  await expect(workflow.getByTestId("context-chart")).toBeVisible();
  await expect(workflow.getByTestId("node-timeline")).toBeVisible();
  await expect(workflow.getByTestId("timeline-row-toolu_agent1")).toBeVisible();
  await openDisclosure(workflow.getByTestId("workflow-children"));
  await expect(workflow.getByTestId("sub-agent-toolu_agent1")).toBeVisible();
  const calls = dialog.getByRole("tabpanel");
  await openDisclosure(calls.getByTestId("workflow-calls"));
  await calls.getByRole("button", { name: "Expand LLM call 2" }).click();
  const callEvidence = calls.getByTestId("call-cost-u1-1").locator("xpath=following-sibling::tr[1]");
  await expect(callEvidence.getByText("Source evidence", { exact: true })).toHaveCount(0);
  await expect(callEvidence).not.toContainText("Timing evidence");
  await expect(callEvidence.getByTestId("tool-call-toolu_read1")).toHaveCount(0);
  const read = calls.getByTestId("tool-execution-u1-subject:toolu_read1");
  await expect(read).toHaveCount(1);
  await read.getByRole("button", { name: "Expand Read" }).click();
  const readDetails = read.locator("xpath=following-sibling::tr[1]");
  await expect(readDetails.getByText("Source evidence", { exact: true })).toHaveCount(0);
  await expect(readDetails.getByText("Requester", { exact: true })).toBeVisible();
  await readDetails.getByRole("link", { name: "Open tool details" }).click();
  await expect(dialog.locator(".mantine-Drawer-title .mantine-Text-root")).toHaveText("Read");
  const content = dialog.getByRole("tabpanel");
  await expect(content.getByText("def parse():")).toBeVisible();
  await expect(page.getByTestId("tree-row-u1")).toHaveAttribute("data-inspected", "true");
});

test("show the main agent's whole context in the session's detail drawer", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await expect(page.getByTestId("tree-row-session")).toBeVisible();
  await expect(page.getByTestId("context-session")).not.toHaveText("–");
  await page.getByTestId("tree-row-session").getByRole("link", { name: "Show details: Fix the parser" }).click();
  const dialog = page.getByRole("dialog");
  const overview = dialog.getByRole("tabpanel");
  await expect(overview.getByTestId("metrics-cost-own")).toBeVisible();
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  const workflow = dialog.getByRole("tabpanel");
  await expect(workflow.getByTestId("context-section")).toBeVisible();
  await expect(workflow.getByTestId("context-chart")).toBeVisible();
  await expect(workflow.getByTestId("node-timeline")).toBeVisible();
  await expect(workflow.getByTestId("timeline-row-u1")).toBeVisible();
  await expect(workflow.getByTestId("timeline-row-u2")).toBeVisible();
  await openDisclosure(workflow.getByTestId("workflow-children"));
  await expect(workflow.getByTestId("turn-u1")).toBeVisible();

  await workflow.getByTestId("turn-u2").click();
  await expect(workflow.getByTestId("turn-u2")).toHaveAttribute("data-selection", "exact");
});

test("trace the main agent cost from its summary to an LLM call in a turn", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  const mainAgent = page.getByTestId("agent-summary-row-1");
  await mainAgent.getByRole("link", { name: "Show details: Fix the parser" }).click();
  const dialog = page.getByRole("dialog");
  const overview = dialog.getByRole("tabpanel");
  await expect(dialog.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(overview.getByTestId("metrics-cost-own")).not.toHaveText("–");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  const calls = dialog.getByRole("tabpanel");
  await openDisclosure(calls.getByTestId("workflow-calls"));
  await expect(calls.getByTestId("cost-chart")).toBeVisible();
  const turn = calls.getByTestId("call-turn-u1");
  await expect(turn.getByTestId("cost-own")).not.toHaveText("–");
  await expect(turn.getByTestId("cost-total")).not.toHaveText("–");
  await page.getByTestId("expand-call-turn-u1").click();
  await expect(calls.getByTestId("call-cost-u1-0")).toBeVisible();
  await calls.getByTestId("call-cost-u1-0").getByRole("button", { name: "Expand LLM call 1" }).click();
  const metrics = calls.getByTestId("mobile-call-metrics-u1-0");
  await expect(metrics).toContainText("500");
  for (const label of ["Input", "Cache read", "Cache write", "Cache write 5m", "Cache write 1h", "Output"]) {
    await expect(metrics).toContainText(label);
  }
  await calls.getByTestId("expand-call-turn-u1").click();
  await calls.getByTestId("cost-bar-u1-0").click();
  await expect(calls.getByTestId("call-cost-u1-0")).toHaveCount(0);
  await calls.getByTestId("expand-call-turn-u1").click();
  await expect(calls.getByTestId("call-cost-u1-0")).toBeVisible();
  const call = calls.getByTestId("call-cost-u1-0");
  await call.click({ button: "right" });
  await page
    .getByRole("menu", { name: "Inspection actions" })
    .getByRole("menuitem", { name: "Show details", exact: true })
    .click();
  await expect(calls.getByRole("button", { name: "Collapse LLM call 1" })).toBeVisible();
  await calls.getByTestId("cost-bar-u1-0").click();
  await expect(calls.getByRole("button", { name: "Collapse LLM call 1" })).toBeVisible();
  await calls.getByTestId("cost-bar-u1-0").click();
  await expect(calls.getByRole("button", { name: "Collapse LLM call 1" })).toBeVisible();
});

test("show a sub-agent's own LLM call costs in its existing drawer", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await page.getByTestId("agent-summary-row-2").getByRole("link", { name: "Show details: Investigate tests" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tabpanel").getByTestId("metrics-cost-own")).not.toHaveText("–");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await openDisclosure(dialog.getByRole("tabpanel").getByTestId("workflow-calls"));
  const calls = dialog.getByRole("tabpanel");
  await expect(calls.getByTestId("cost-chart")).toBeVisible();
  await expect(calls.getByTestId("call-cost-toolu_agent1-0")).toBeVisible();
});

test("select a sub-agent from the drawer", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    const agent = turn.children.find((child: { node_id: string }) => child.node_id === "toolu_agent1");
    const call = agent.llm_calls[0];
    call.preceding_events = [
      {
        kind: "tool",
        event_id: "toolu_grep1",
        start: call.start,
        end: metric(call.start.value + 50),
        duration: metric(50),
      },
    ];
    agent.execution_events = [
      makeExecutionEvent({
        event_id: "grep-result-event",
        kind: "tool_result",
        subject_node_id: "toolu_grep1",
        start: metric(call.start.value + 100),
      }),
    ];
    await route.fulfill({ response, json: session });
  });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await page.getByTestId("tree-row-u1").getByRole("link", { name: "Show details: Fix the parser" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await openDisclosure(dialog.getByRole("tabpanel").getByTestId("workflow-children"));
  await dialog
    .getByRole("tabpanel")
    .getByTestId("sub-agent-toolu_agent1")
    .getByRole("link", { name: "Show details: Investigate tests" })
    .click();
  await expect(dialog.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await openDisclosure(dialog.getByRole("tabpanel").getByTestId("workflow-calls"));
  const calls = dialog.getByRole("tabpanel");
  await calls.getByRole("button", { name: "Expand LLM call 1" }).click();
  await expect(
    calls
      .getByTestId("call-cost-toolu_agent1-0")
      .locator("xpath=following-sibling::tr[1]")
      .getByText("Source evidence", { exact: true }),
  ).toHaveCount(0);
  await expect(
    calls
      .getByTestId("call-cost-toolu_agent1-0")
      .locator("xpath=following-sibling::tr[1]")
      .getByTestId("tool-call-toolu_grep1"),
  ).toHaveCount(0);
  const grep = calls.getByTestId("tool-execution-toolu_agent1-subject:toolu_grep1");
  await expect(grep).toHaveCount(1);
  await grep.getByRole("button", { name: "Expand Grep" }).click();
  const grepDetails = grep.locator("xpath=following-sibling::tr[1]");
  await expect(grepDetails.getByText("Source evidence", { exact: true })).toHaveCount(0);
  await grepDetails.getByRole("link", { name: "Open tool details" }).click();
  await expectNodeParam(page, "toolu_grep1");
  await expect(page.getByTestId("tree-row-toolu_agent1")).toHaveAttribute("data-inspected", "true");
});

test("select a nested sub-agent from the drawer and reveal its row", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await expect(page.getByTestId("tree-row-toolu_agent2")).toHaveCount(0);
  await page.getByTestId("tree-row-u1").getByRole("link", { name: "Show details: Fix the parser" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await openDisclosure(dialog.getByRole("tabpanel").getByTestId("workflow-children"));
  const workflow = dialog.getByRole("tabpanel");
  await workflow
    .getByTestId("sub-agent-toolu_agent1")
    .getByRole("link", { name: "Show details: Investigate tests" })
    .click();
  await expect(dialog.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await openDisclosure(dialog.getByRole("tabpanel").getByTestId("workflow-children"));
  await dialog
    .getByRole("tabpanel")
    .getByTestId("sub-agent-toolu_agent2")
    .getByRole("link", { name: "Show details: Check fixtures" })
    .click();
  await expect(dialog.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("tree-row-toolu_agent2")).toHaveAttribute("aria-selected", "true");
});

test("drawer history follows browser Back and Forward", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    const call = turn.llm_calls[1];
    turn.execution_events = [
      makeExecutionEvent({
        event_id: "tool-result:history-read",
        kind: "tool_result",
        subject_node_id: "toolu_read1",
        start: metric(call.start.value + 100),
      }),
    ];
    await route.fulfill({ response, json: session });
  });
  await page.goto("/");
  const sessionRow = page.getByTestId(`session-row-${SESSION}`);
  await sessionRow.click();
  await page.getByTestId("tree-row-u1").getByRole("link", { name: "Show details: Fix the parser" }).click();
  await expectNodeParam(page, "u1");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await openDisclosure(dialog.getByRole("tabpanel").getByTestId("workflow-calls"));
  const calls = dialog.getByRole("tabpanel");
  const invocation = calls.getByTestId("tool-execution-u1-subject:toolu_read1");
  await invocation.getByRole("button", { name: "Expand Read" }).click();
  await invocation.locator("xpath=following-sibling::tr[1]").getByRole("link", { name: "Open tool details" }).click();
  await expectNodeParam(page, "toolu_read1");

  await page.goBack();
  await expectNodeParam(page, "u1");
  await expect(page.getByTestId("tree-row-u1")).toHaveAttribute("data-inspected", "true");
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/sessions/${encodeURIComponent(SESSION)}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goForward();
  await expectNodeParam(page, "u1");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL("/");
});

test("drawer history opens a direct node URL and ignores unknown nodes", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=toolu_read1`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Content", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tabpanel").getByText("def parse():")).toBeVisible();
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=missing`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectNodeParam(page, "missing");
});

test("drawer parent returns a main-agent tool to the session", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=toolu_read1`);
  await page.getByRole("button", { name: "To parent" }).click();
  await expectNodeParam(page, "session");
  await expect(page.getByTestId("tree-row-session")).toHaveAttribute("data-inspected", "true");
  await expect(page.getByRole("button", { name: "To parent" })).toHaveCount(0);
});

test("drawer parent returns a nested sub-agent to its calling agent", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=toolu_agent2`);
  await page.getByRole("button", { name: "To parent" }).click();
  await expectNodeParam(page, "toolu_agent1");
  await expect(page.getByTestId("tree-row-toolu_agent1")).toHaveAttribute("aria-selected", "true");
});

test("reveal a finding with the findings filter on", async ({ page }) => {
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await page.getByLabel("Only rows with findings").click();
  await page.getByRole("button", { name: /Findings \(\d+\)/ }).click();
  const finding = page.getByTestId("finding-W4-u2");
  await finding.click();
  await expect(finding).toHaveAttribute("data-selection", "local");
  await expect(page.getByTestId("tree-row-u2")).toHaveAttribute("aria-selected", "false");
  await finding.getByRole("link", { name: /Show details:/ }).click();
  await expectNodeParam(page, "u2");
  await expect(page.getByTestId("tree-row-u2")).toHaveAttribute("data-inspected", "true");
});

test("colors session and tree metrics by their p90 scale", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId(`session-duration-${SESSION}`)).toHaveCSS("color", "rgb(183, 108, 108)");

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await expect(page.getByTestId("tree-duration-session")).toHaveCSS("color", "rgb(183, 108, 108)");
});
