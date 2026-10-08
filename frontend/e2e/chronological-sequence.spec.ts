// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, type Locator, test } from "@playwright/test";
import type { SessionOut } from "../src/api/types";
import { cost, makeCall, makeExecutionEvent, makeNode, metric } from "../src/test/factories";
import { assertNoSelectionActionControls } from "./helpers/workflowFixture";

const SESSION = "claude-code:11111111-1111-4111-8111-111111111111";

async function openWorkflowCalls(dialog: Locator): Promise<void> {
  const disclosure = dialog.getByTestId("workflow-calls");
  if ((await disclosure.getAttribute("open")) === null) await disclosure.locator("summary").click();
}

async function focusTurnSubtree(page: import("@playwright/test").Page): Promise<void> {
  const turn = page.getByTestId("tree-row-u1");
  await turn.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Focus subtree", exact: true }).click();
}

test("contiguous tool invocations collapse into a triangle-controlled names row", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = session.root.children.find((child) => child.node_id === "u1");
    if (turn === undefined) throw new Error("The browser fixture has no u1 turn");
    turn.llm_calls = [];
    const read = turn.children.find((child) => child.node_id === "toolu_read1");
    if (!read?.tool) throw new Error("Missing Read tool");
    const bash = structuredClone(read);
    bash.node_id = "group-bash";
    if (!bash.tool) throw new Error("Missing cloned tool details");
    bash.tool.native_id = "Bash";
    turn.children = [read, bash];
    turn.execution_events = [
      makeExecutionEvent({
        event_id: "tool-start:read-a",
        subject_node_id: "toolu_read1",
        kind: "tool_start",
        source_stream_id: "tools",
        start: metric(100),
      }),
      makeExecutionEvent({
        event_id: "tool-result:read-a",
        subject_node_id: "toolu_read1",
        kind: "tool_result",
        source_stream_id: "tools",
        start: metric(120),
      }),
      makeExecutionEvent({
        event_id: "tool-start:read-b",
        subject_node_id: "group-bash",
        kind: "tool_start",
        source_stream_id: "tools",
        start: metric(200),
      }),
      makeExecutionEvent({
        event_id: "tool-result:read-b",
        subject_node_id: "group-bash",
        kind: "tool_result",
        source_stream_id: "tools",
        start: metric(230),
      }),
    ];
    await route.fulfill({ response, json: session });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  await openWorkflowCalls(page.getByRole("dialog"));
  const calls = page.getByRole("dialog").getByRole("tabpanel");
  const group = calls.getByRole("button", { name: "Expand 2 tools" }).locator("xpath=ancestor::tr");
  await expect(group.locator('td[data-label="Item"]')).toHaveText("Read, Bash");
  await expect(group.locator('td[data-label="Duration"]')).toHaveText("130ms");
  await expect(group).not.toContainText("Execution total");
  await expect(group.getByRole("button", { name: "Expand 2 tools" })).toHaveAttribute("aria-expanded", "false");
  await expect(calls.locator('tr[data-testid^="tool-execution-u1-"]')).toHaveCount(0);
  await group.locator('td[data-label="Item"]').click();
  await expect(group.getByRole("button", { name: "Expand 2 tools" })).toHaveAttribute("aria-expanded", "false");
  await group.getByRole("button", { name: "Expand 2 tools" }).click();
  await expect(calls.getByTestId("tool-group-metrics-u1-0")).toContainText("Elapsed 130ms");
  await expect(calls.getByTestId("tool-group-metrics-u1-0")).toContainText("Execution total");
  await expect(calls.locator('tr[data-testid^="tool-execution-u1-"]')).toHaveCount(2);
  await expect(calls.getByRole("link", { name: "Open tool details" })).toHaveCount(2);
  await expect(calls.getByRole("button", { name: "Collapse Read", exact: true })).toBeVisible();
  await expect(calls.getByRole("button", { name: "Collapse Bash", exact: true })).toBeVisible();
  await calls.getByRole("button", { name: "Collapse Read", exact: true }).click();
  await expect(calls.getByRole("link", { name: "Open tool details" })).toHaveCount(1);
});

test("start and result evidence share one tool invocation with explicit details", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = session.root.children.find((child) => child.node_id === "u1");
    if (turn === undefined) throw new Error("The browser fixture has no u1 turn");
    const call = turn.llm_calls[1];
    if (call === undefined) throw new Error("The browser fixture has no second call");
    call.source_request_id = "read-request";
    turn.execution_events = [
      makeExecutionEvent({
        event_id: "tool-start:read-invocation",
        kind: "tool_start",
        subject_node_id: "toolu_read1",
        start: metric((call.start.value ?? 0) + 50),
        links: [{ owner_id: "u1", source_request_id: "read-request", relation: "requested_by", evidence: "recorded" }],
      }),
      makeExecutionEvent({
        event_id: "tool-result:read-invocation",
        kind: "tool_result",
        subject_node_id: "toolu_read1",
        start: metric((call.start.value ?? 0) + 100),
        success: false,
      }),
    ];
    await route.fulfill({ response, json: session });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  const dialog = page.getByRole("dialog");
  await openWorkflowCalls(dialog);
  const calls = dialog.getByRole("tabpanel");
  const invocation = calls.getByTestId("tool-execution-u1-subject:toolu_read1");
  await expect(invocation).toHaveCount(1);
  await expect(invocation).toContainText("failed");
  await invocation.getByRole("button", { name: "Expand Read" }).click();
  const evidence = invocation.locator("xpath=following-sibling::tr[1]");
  await expect(evidence).toContainText("Failed");
  await expect(evidence.getByText("Source evidence", { exact: true })).toHaveCount(0);
  await expect(evidence.getByText("Requester", { exact: true })).toBeVisible();
  await expect(evidence.getByRole("link", { name: "LLM call 2", exact: true })).toBeVisible();

  await invocation.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Inspection actions" });
  await menu.getByRole("menuitem", { name: /Show requesting call:/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("sel")).toBe("call");
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");

  await evidence.getByRole("link", { name: "Open tool details" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("toolu_read1");
  await expect(dialog.getByRole("tab", { name: "Content", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  await expect(dialog.getByRole("tab", { name: "Workflow", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("activity events stay individually addressable and their evidence expands in place", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = session.root.children.find((child) => child.node_id === "u1");
    if (turn === undefined) throw new Error("The browser fixture has no u1 turn");
    turn.execution_events = [
      makeExecutionEvent({
        event_id: "activity-one",
        kind: "message",
        start: metric((turn.start.value ?? 0) + 100),
      }),
      makeExecutionEvent({
        event_id: "activity-two",
        kind: "message",
        start: metric((turn.start.value ?? 0) + 200),
      }),
    ];
    await route.fulfill({ response, json: session });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  await openWorkflowCalls(page.getByRole("dialog"));
  const calls = page.getByRole("dialog").getByRole("tabpanel");
  const activities = calls.locator("tbody tr").filter({ hasText: "message" });
  await expect(activities).toHaveCount(2);
  const first = activities.first();
  await first.click();
  await expect(first).toHaveAttribute("data-selection", "exact");
  await first.getByRole("button", { name: "Expand message" }).click();
  await first.locator("xpath=following-sibling::tr[1]").getByText("Source evidence", { exact: true }).click();
  await expect(first.locator("xpath=following-sibling::tr[1]")).toContainText("activity-one");
  await expect(first.locator("xpath=following-sibling::tr[1]")).not.toContainText("activity-two");
});

test("Calls sorting is controlled by the visible column headers", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = session.root.children.find((child) => child.node_id === "u1");
    if (turn === undefined) throw new Error("The browser fixture has no u1 turn");
    turn.llm_calls = [
      makeCall({ model: "sort-low", start: metric(100), cost: cost(1, "USD", undefined, 1) }),
      makeCall({ model: "sort-high", start: metric(200), cost: cost(9, "USD", undefined, 9) }),
    ];
    turn.execution_events = [];
    await route.fulfill({ response, json: session });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  await openWorkflowCalls(page.getByRole("dialog"));
  const calls = page.getByRole("dialog").getByRole("tabpanel");
  const costHeader = calls.locator('[data-testid="workflow-calls"]').getByRole("columnheader", { name: /Cost/ });
  await costHeader.getByRole("button", { name: /Cost/ }).click();
  await expect(costHeader).toHaveAttribute("aria-sort", "descending");
  const callRows = calls.locator('tbody tr[data-testid^="call-cost-u1-"]');
  await expect(callRows.first()).toHaveAttribute("data-testid", "call-cost-u1-1");
  await expect(callRows.last()).toHaveAttribute("data-testid", "call-cost-u1-0");
  await callRows.first().getByRole("button", { name: "Expand LLM call 2" }).click();
  await expect(callRows.first().locator("xpath=following-sibling::tr[1]")).toContainText("sort-high");
  await expect(calls.getByLabel("Sequence mode")).toHaveCount(0);
  await expect(calls.getByLabel("Sequence order")).toHaveCount(0);
});

test("Calls summaries stay on one line and expose readable tool details before source evidence", async ({
  page,
}, testInfo) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = session.root.children.find((child) => child.node_id === "u1");
    if (!turn) throw new Error("Missing public fixture turn");
    const tool = turn.children.find((child) => child.node_id === "toolu_read1");
    if (!tool?.tool) throw new Error("Missing public fixture Read tool");
    tool.tool.path = "src/a-long-readable-path/with-many-components/parser.ts";
    turn.children = [tool];
    const time = turn.llm_calls[1].start.value ?? 0;
    turn.execution_events = [
      makeExecutionEvent({
        event_id: "tool-start:compact-readable",
        kind: "tool_start",
        subject_node_id: tool.node_id,
        source_stream_id: "compact-source-stream",
        source_order: 17,
        start: metric(time + 10),
      }),
      makeExecutionEvent({
        event_id: "tool-result:compact-readable",
        kind: "tool_result",
        source_stream_id: "compact-source-stream",
        subject_node_id: tool.node_id,
        start: metric(time + 50),
        success: false,
      }),
    ];
    await route.fulfill({ response, json: session });
  });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
    await openWorkflowCalls(page.getByRole("dialog"));
    const panel = page.getByRole("dialog").getByRole("tabpanel");
    const call = panel.getByTestId("call-cost-u1-1");
    const tool = panel.getByTestId("tool-execution-u1-subject:toolu_read1");
    for (const row of [call, tool]) {
      expect((await row.boundingBox())?.height).toBeLessThanOrEqual(32);
      await expect(row.getByRole("cell")).toHaveCount(5);
      await expect(row.getByRole("button", { name: /^Show details:/ })).toHaveCount(0);
      for (const cell of await row.getByRole("cell").all()) {
        expect(await cell.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("nowrap");
      }
    }
    await expect(tool.locator('td[data-label="Item"]')).toContainText("Read");
    await expect(tool.locator('td[data-label="Item"]')).not.toContainText("parser.ts");
    const numericHeaders = panel.locator("thead th").filter({ hasText: /^(Duration|Cost|Tokens)$/ });
    for (const header of await numericHeaders.all()) {
      const label = await header.innerText();
      const headerBounds = await header.boundingBox();
      if (!headerBounds) throw new Error("Missing header bounds");
      expect(headerBounds.width).toBeGreaterThanOrEqual(80);
      expect(headerBounds.width).toBeLessThanOrEqual(112);
      for (const row of [call, tool]) {
        const cell = row.locator(`td[data-label="${label}"]`);
        expect(await cell.evaluate((element) => getComputedStyle(element).textAlign)).toBe("right");
        expect(await cell.locator("p").evaluate((element) => getComputedStyle(element).textAlign)).toBe("right");
        const cellBounds = await cell.boundingBox();
        expect(cellBounds?.x).toBeCloseTo(headerBounds.x, 0);
        expect(cellBounds?.width).toBeCloseTo(headerBounds.width, 0);
      }
    }
    await expect(call.locator('td[data-label="Item"]')).toHaveText("LLM call 2");
    const scroll = panel.getByTestId("calls-scroll-u1");
    if (viewport.width === 390) {
      expect(await scroll.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
      await scroll.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      expect(await scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      await scroll.evaluate((element) => {
        element.scrollLeft = 0;
      });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await page.screenshot({ path: testInfo.outputPath(`compact-calls-${viewport.width}.png`) });
    await tool.click();
    await expect(tool).toHaveAttribute("data-selection", "exact");
    await expect(tool.getByRole("button", { name: "Expand Read" })).toHaveAttribute("aria-expanded", "false");
    await tool.getByRole("button", { name: "Expand Read" }).click();
    const details = tool.locator("xpath=following-sibling::tr[1]");
    for (const label of ["Started", "Finished", "Duration", "Outcome"])
      await expect(details.getByText(label, { exact: true })).toBeVisible();
    await expect(
      details.getByText("src/a-long-readable-path/with-many-components/parser.ts", { exact: true }),
    ).toBeVisible();
    if (viewport.width === 390) {
      const bounds = await scroll.boundingBox();
      if (bounds === null) throw new Error("Calls scroll container has no bounds");
      for (const label of ["Started", "Finished", "Duration", "Outcome"]) {
        const field = details.getByText(label, { exact: true });
        const fieldBounds = await field.boundingBox();
        if (fieldBounds === null) throw new Error(`${label} has no bounds`);
        expect(fieldBounds.x).toBeGreaterThanOrEqual(bounds.x);
        expect(fieldBounds.x + fieldBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      }
    }
    await expect(details.getByText("tool-start:compact-readable", { exact: true })).not.toBeVisible();
    const streams = details.getByText("compact-source-stream", { exact: true });
    await expect(streams).toHaveCount(0);
    for (const stream of await streams.all()) await expect(stream).not.toBeVisible();
    await details.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`expanded-tool-${viewport.width}.png`) });
    await expect(details.getByText("Source evidence", { exact: true })).toHaveCount(0);
    await expect(details.getByText("Requester", { exact: true })).toBeVisible();
    await expect(details.getByText("Result user", { exact: true })).toBeVisible();
    const link = details.getByRole("link", { name: "Open tool details" });
    await expect(link).toHaveAttribute("href", /node=toolu_read1.*tab=content/);
    await link.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("toolu_read1");
    await expect(page.getByRole("dialog").getByRole("tab", { name: "Content", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
    await expect(page.getByRole("dialog").getByRole("tab", { name: "Workflow", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }
});

test("tool requester and result user links reveal and mark calls without expanding them", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = session.root.children.find((child) => child.node_id === "u1");
    if (!turn) throw new Error("Missing turn");
    const time = turn.start.value ?? 0;
    turn.llm_calls = Array.from({ length: 40 }, (_, index) =>
      makeCall({
        source_request_id: `jump-request-${index}`,
        call_id: `jump-call-${index}`,
        start: metric(time + index * 1000),
      }),
    );
    turn.children = turn.children.filter((child) => child.node_id === "toolu_read1");
    turn.children.push(
      makeNode({
        node_id: "descendant-agent-guard",
        kind: "agent",
        agent_id: 809,
        topic: "Descendant agent guard",
        activity: "running",
      }),
    );
    session.root.children.push(
      makeNode({
        node_id: "resume-old-guard",
        kind: "agent",
        agent_id: 808,
        topic: "Earlier completed guard work",
        activity: "completed",
        execution_events: [
          makeExecutionEvent({
            event_id: "completion:resume-guard",
            kind: "completion",
            source_stream_id: "resume-guard",
            source_order: 1,
            start: metric(time + 1),
          }),
        ],
      }),
      makeNode({
        node_id: "resume-new-guard",
        kind: "agent",
        agent_id: 808,
        topic: "Latest resumed guard work",
        activity: "running",
        resume_times: [metric(time + 2)],
        llm_calls: [makeCall({ call_id: "resume-guard-call", start: metric(time + 3) })],
      }),
    );
    turn.execution_events = [
      makeExecutionEvent({
        event_id: "tool-start:jump",
        kind: "tool_start",
        subject_node_id: "toolu_read1",
        start: metric(time + 20001),
        links: [
          { owner_id: "u1", source_request_id: "jump-request-0", relation: "requested_by", evidence: "recorded" },
        ],
      }),
      makeExecutionEvent({
        event_id: "tool-result:jump",
        kind: "tool_result",
        subject_node_id: "toolu_read1",
        start: metric(time + 20002),
        links: [
          { owner_id: "u1", source_request_id: "jump-request-39", relation: "consumed_by", evidence: "recorded" },
        ],
      }),
      makeExecutionEvent({
        event_id: "scope-activity",
        kind: "compaction",
        source_stream_id: "recorded-activity",
        start: metric(time + 40_000),
      }),
    ];
    await route.fulfill({ response, json: session });
  });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const expectResumedRowUnpainted = async () => {
      if (viewport.width < 768) {
        await page.getByRole("button", { name: "Agents", exact: true }).click();
        await expect(page.getByTestId("agent-summary-card-808")).toHaveAttribute("data-selection", "none");
        await page.getByRole("button", { name: "Workflow", exact: true }).click();
      } else {
        await expect(page.getByTestId("agent-summary-row-808")).toHaveAttribute("data-selection", "none");
      }
    };
    await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
    await openWorkflowCalls(page.getByRole("dialog"));
    const calls = page.getByRole("dialog").getByRole("tabpanel");
    await calls.getByLabel("Search calls and tools").fill("Read");
    const tool = calls.getByTestId("tool-execution-u1-subject:toolu_read1");
    await tool.getByRole("button", { name: "Expand Read" }).click();
    const details = tool.locator("xpath=following-sibling::tr[1]");
    await expect(details.getByText("Source evidence", { exact: true })).toHaveCount(0);
    await expect(
      details
        .getByText("Started", { exact: true })
        .locator("xpath=parent::div")
        .getByRole("link", { name: "LLM call 1", exact: true }),
    ).toBeVisible();
    await expect(
      details
        .getByText("Finished", { exact: true })
        .locator("xpath=parent::div")
        .getByRole("link", { name: "LLM call 40", exact: true }),
    ).toBeVisible();
    for (const [label, number, index] of [
      ["Requester", 1, 0],
      ["Result user", 40, 39],
    ] as const) {
      const section = details
        .locator("div")
        .filter({ has: page.getByText(label, { exact: true }) })
        .last();
      const link = section.getByRole("link", { name: `LLM call ${number}`, exact: true });
      await expect(link).toHaveAttribute("href", /node=u1.*tab=workflow/);
      await link.click();
      await expect(calls.getByLabel("Search calls and tools")).toHaveValue("");
      const target = calls.getByTestId(`call-cost-u1-${index}`);
      await expect(target).toHaveAttribute("data-selection", "exact");
      await expect(target.getByRole("button", { name: `Expand LLM call ${number}` })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await expect(target).toBeInViewport();
      expect(new URL(page.url()).searchParams.get("node")).toBe("u1");
    }

    await expect(calls.getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "none");
    await expect(calls.getByTestId("call-cost-u1-39")).toHaveAttribute("data-selection", "exact");

    const callUrl = new URL(page.url());
    expect(callUrl.searchParams.get("call")).toBe("id:jump-call-39");
    await page.getByRole("button", { name: "Close details" }).click();
    await assertNoSelectionActionControls(page);
    await focusTurnSubtree(page);
    await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("u1");
    await expect(page.getByTestId("track-u1").getByTestId("timeline-call-u1-39")).toHaveAttribute(
      "data-selection",
      "exact",
    );
    await expect(page.getByTestId("tree-row-u1")).toHaveAttribute("data-selection", "none");
    await expect(page.getByTestId("tree-row-session")).toHaveCount(0);
    const descendantAgent = page.getByTestId("tree-row-descendant-agent-guard");
    if ((await descendantAgent.count()) === 0) await page.getByTestId("toggle-u1").click();
    await expect(descendantAgent).toHaveAttribute("data-selection", "none");
    await expectResumedRowUnpainted();
    await assertNoSelectionActionControls(page);
    expect(new URL(page.url()).searchParams.get("call")).toBe("id:jump-call-39");
    expect(new URL(page.url()).searchParams.get("owner")).toBe("u1");
    await page.getByRole("button", { name: "Whole session" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has("scope")).toBe(false);
    await expect(page.getByTestId("track-u1").getByTestId("timeline-call-u1-39")).toHaveAttribute(
      "data-selection",
      "exact",
    );
    await expect(page.getByTestId("tree-row-session")).toHaveAttribute("data-selection", "none");
    await expect(page.getByTestId("tree-row-u1")).toHaveAttribute("data-selection", "none");
    await expect(descendantAgent).toHaveAttribute("data-selection", "none");
    await expectResumedRowUnpainted();
    await assertNoSelectionActionControls(page);

    await page
      .getByTestId("tree-row-u1")
      .getByRole("link", { name: /Show details:/ })
      .click();
    const eventDialog = page.getByRole("dialog");
    await eventDialog.getByRole("tab", { name: "Workflow", exact: true }).click();
    await openWorkflowCalls(eventDialog);
    await eventDialog.getByLabel("Search calls and tools").fill("");
    const eventRow = eventDialog.locator("tr").filter({ hasText: "compaction" }).last();
    await expect(eventRow).toBeVisible();
    await eventRow.locator("td").first().click();
    await expect(eventRow).toHaveAttribute("data-selection", "exact");
    await expect(page.getByTestId("tree-row-u1")).toHaveAttribute("data-selection", "none");
    await expect(page.getByTestId("tree-row-session")).toHaveAttribute("data-selection", "none");
    await expect(eventDialog.getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "none");
    await expect(eventDialog.getByTestId("call-cost-u1-39")).toHaveAttribute("data-selection", "none");
    await expect(eventDialog.getByTestId("tool-execution-u1-subject:toolu_read1")).toHaveAttribute(
      "data-selection",
      "none",
    );
    await expect(descendantAgent).toHaveAttribute("data-selection", "none");
    await assertNoSelectionActionControls(page);
    expect(new URL(page.url()).searchParams.get("event")).toBe("scope-activity");
    expect(new URL(page.url()).searchParams.get("sel")).toBe("event");
    expect(new URL(page.url()).searchParams.get("owner")).toBe("u1");
    expect(new URL(page.url()).searchParams.has("call")).toBe(false);
    await page.getByRole("button", { name: "Close details" }).click();
    await focusTurnSubtree(page);
    await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("u1");
    await expect.poll(() => new URL(page.url()).searchParams.get("event")).toBe("scope-activity");
    await expect(page.getByTestId("tree-row-session")).toHaveCount(0);
    await expect(descendantAgent).toHaveAttribute("data-selection", "none");
    expect(new URL(page.url()).searchParams.get("owner")).toBe("u1");
    await assertNoSelectionActionControls(page);
    const focusedEventUrl = new URL(page.url());
    focusedEventUrl.searchParams.set("node", "u1");
    focusedEventUrl.searchParams.set("tab", "workflow");
    await page.goto(`${focusedEventUrl.pathname}${focusedEventUrl.search}`);
    const focusedEventDialog = page.getByRole("dialog");
    await focusedEventDialog.getByLabel("Search calls and tools").fill("");
    const focusedEventRow = focusedEventDialog.locator("tr").filter({ hasText: "compaction" }).last();
    await expect(focusedEventRow).toHaveAttribute("data-selection", "exact");
    await expect(focusedEventDialog.getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "none");
    await expect(focusedEventDialog.getByTestId("call-cost-u1-39")).toHaveAttribute("data-selection", "none");
    await assertNoSelectionActionControls(page);
    await page.getByRole("button", { name: "Close details" }).click();
    await page.getByRole("button", { name: "Whole session" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has("scope")).toBe(false);
    await expect.poll(() => new URL(page.url()).searchParams.get("event")).toBe("scope-activity");
    expect(new URL(page.url()).searchParams.get("owner")).toBe("u1");
    await expect(page.getByTestId("tree-row-session")).toHaveAttribute("data-selection", "none");
    const wholeEventUrl = new URL(page.url());
    wholeEventUrl.searchParams.set("node", "u1");
    wholeEventUrl.searchParams.set("tab", "workflow");
    await page.goto(`${wholeEventUrl.pathname}${wholeEventUrl.search}`);
    const reopenedEventDialog = page.getByRole("dialog");
    await reopenedEventDialog.getByLabel("Search calls and tools").fill("");
    const reopenedEventRow = reopenedEventDialog.locator("tr").filter({ hasText: "compaction" }).last();
    await expect(reopenedEventRow).toHaveAttribute("data-selection", "exact");
    await expect(reopenedEventDialog.getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "none");
    await expect(reopenedEventDialog.getByTestId("call-cost-u1-39")).toHaveAttribute("data-selection", "none");
    await expect(reopenedEventDialog.getByTestId("tool-execution-u1-subject:toolu_read1")).toHaveAttribute(
      "data-selection",
      "none",
    );
    await page.getByRole("button", { name: "Close details" }).click();
    await expectResumedRowUnpainted();
    await assertNoSelectionActionControls(page);
  }
});

test("tool relationship jumps to a call owned by another turn without expanding it", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = session.root.children.find((child) => child.node_id === "u1");
    if (!turn) throw new Error("Missing turn");
    const other = structuredClone(turn);
    other.node_id = "other-turn";
    other.children = [];
    other.execution_events = [];
    other.llm_calls = [
      makeCall({
        call_id: "other-call",
        source_request_id: "other-request",
        start: metric((turn.start.value ?? 0) + 100),
      }),
    ];
    session.root.children.push(other);
    turn.llm_calls = [];
    turn.children = turn.children.filter((child) => child.node_id === "toolu_read1");
    turn.execution_events = [
      makeExecutionEvent({
        event_id: "tool-start:other-request",
        kind: "tool_start",
        subject_node_id: "toolu_read1",
        start: metric((turn.start.value ?? 0) + 101),
        links: [
          {
            owner_id: "other-turn",
            source_request_id: "other-request",
            relation: "requested_by",
            evidence: "recorded",
          },
        ],
      }),
    ];
    await route.fulfill({ response, json: session });
  });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  await openWorkflowCalls(page.getByRole("dialog"));
  const panel = page.getByRole("dialog").getByRole("tabpanel");
  const tool = panel.getByTestId("tool-execution-u1-subject:toolu_read1");
  await tool.getByRole("button", { name: "Expand Read" }).click();
  await tool.locator("xpath=following-sibling::tr[1]").getByRole("link", { name: "LLM call 1", exact: true }).click();
  const target = panel.getByTestId("call-cost-other-turn-0");
  await expect(target).toHaveAttribute("data-selection", "exact");
  await expect(target.getByRole("button", { name: "Expand LLM call 1" })).toHaveAttribute("aria-expanded", "false");
  await expect(target).toBeInViewport();
});
