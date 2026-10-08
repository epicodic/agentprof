// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, type Locator, test } from "@playwright/test";
import type { NodeOut, SessionOut } from "../src/api/types";
import { cost, makeCall, makeNode, makeSession, makeTool, metric, tokens } from "../src/test/factories";

const SESSION = "synthetic:large-public-workflow";
const BASE_TIME = Date.UTC(2026, 9, 5, 9, 0, 0);

async function openDisclosure(disclosure: Locator): Promise<void> {
  if ((await disclosure.getAttribute("open")) === null) await disclosure.locator("summary").click();
}
function makeLargeWorkflow(): SessionOut {
  let toolOrdinal = 0;
  const makeToolNodes = (count: number, _owner: string, offset: number): NodeOut[] =>
    Array.from({ length: count }, (_, index) => {
      const ordinal = ++toolOrdinal;
      const start = BASE_TIME + offset + index * 700;
      return makeTool(`tool-${String(ordinal).padStart(3, "0")}`, "Read", {
        topic: `Read source file ${ordinal}`,
        start: metric(start),
        end: metric(start + 220),
        duration: metric(220),
        success: ordinal !== 17,
        tool: {
          native_id: "Read",
          category: "read",
          path: `src/module-${ordinal}.ts`,
          paths: [`src/module-${ordinal}.ts`],
          line_range: null,
          command: null,
          writes_file: false,
          target_agent_id: null,
          is_resume: false,
          linked_agent_node_id: null,
        },
      });
    });

  const makeTurn = (id: string, topic: string, callCount: number, toolCount: number, offset: number): NodeOut => {
    const children = makeToolNodes(toolCount, id, offset);
    const calls = Array.from({ length: callCount }, (_, index) => {
      const start = BASE_TIME + offset + index * 1_000;
      return makeCall({
        call_id: `request-${id}-${String(index + 1).padStart(2, "0")}`,
        model: "synthetic-large-context-model",
        start: metric(start),
        duration: metric(500),
        tokens: tokens(12_000 + index * 100, 800 + index * 10),
        cost: cost(0.002 + index * 0.0001, "USD", undefined, 0.002 + index * 0.0001),
        source_request_id: `request-${id}-${index}`,
        timing_basis: "request_start",
      });
    });
    const executionEvents = children.flatMap((tool, index) => {
      const invocation = `invocation-${tool.node_id}`;
      const start = tool.start.value ?? BASE_TIME;
      const result = tool.end.value ?? start + 220;
      const eventLink = {
        owner_id: id,
        source_request_id: `request-${id}-${index % callCount}`,
        relation: "requested_by" as const,
        evidence: "recorded" as const,
      };
      const startEvent = {
        kind: "tool_start" as const,
        event_id: `tool-start:${invocation}`,
        subject_node_id: tool.node_id,
        start: metric(start),
        source_order: index * 2,
        source_stream_id: `stream-${id}`,
        success: null,
        links: [eventLink],
        execution_start: metric(start),
        execution_end: metric(),
      };
      const resultEvent = {
        kind: "tool_result" as const,
        event_id: `tool-result:${invocation}`,
        subject_node_id: tool.node_id,
        // Invocation 1 finishes after the later model call, preserving a trailing result.
        start: metric(index === 0 ? BASE_TIME + offset + 2_600 : result),
        source_order: index * 2 + 1,
        source_stream_id: `stream-${id}`,
        success: tool.success,
        links:
          index === 0
            ? [
                eventLink,
                {
                  owner_id: id,
                  source_request_id: `request-${id}-2`,
                  relation: "consumed_by" as const,
                  evidence: "recorded" as const,
                },
              ]
            : [eventLink],
        execution_start: metric(start),
        execution_end: metric(index === 0 ? BASE_TIME + offset + 2_600 : result),
      };
      return [startEvent, resultEvent];
    });
    executionEvents.sort((left, right) => (left.start.value ?? 0) - (right.start.value ?? 0));
    return makeNode({
      node_id: id,
      kind: "turn",
      topic,
      start: metric(BASE_TIME + offset),
      end: metric(BASE_TIME + offset + Math.max(callCount * 1_000, toolCount * 700)),
      duration: metric(Math.max(callCount * 1_000, toolCount * 700)),
      llm_calls: calls,
      execution_events: executionEvents,
      children,
    });
  };

  const firstTurn = makeTurn("turn-large-1", "Map the large codebase", 32, 40, 0);
  const secondTurn = makeTurn("turn-large-2", "Verify the implementation", 20, 20, 50_000);
  const nestedAgent = makeNode({
    node_id: "agent-nested-review",
    kind: "agent",
    topic: "Nested review agent",
    agent_id: 9,
    harness_agent_id: "review-agent-9",
    start: metric(BASE_TIME + 10_000),
    end: metric(BASE_TIME + 14_000),
    duration: metric(4_000),
    llm_calls: Array.from({ length: 3 }, (_, index) =>
      makeCall({
        call_id: `request-nested-${index + 1}`,
        model: "synthetic-large-context-model",
        start: metric(BASE_TIME + 10_000 + index * 1_000),
        duration: metric(400),
        tokens: tokens(2_000, 200),
        cost: cost(0.001, "USD", undefined, 0.001),
        source_request_id: `nested-${index + 1}`,
        timing_basis: "request_start",
      }),
    ),
    children: makeToolNodes(4, "agent-nested-review", 10_000),
  });
  firstTurn.children.push(nestedAgent);

  const setRollups = (node: NodeOut): void => {
    node.children.forEach(setRollups);
    const ownCalls = node.llm_calls;
    const ownInput = ownCalls.reduce((sum, call) => sum + (call.tokens.input.value ?? 0), 0);
    const ownOutput = ownCalls.reduce((sum, call) => sum + (call.tokens.output.value ?? 0), 0);
    const ownCost = ownCalls.reduce((sum, call) => sum + (call.cost.value ?? 0), 0);
    node.tokens = tokens(ownInput, ownOutput);
    node.tokens_total = tokens(
      ownInput + node.children.reduce((sum, child) => sum + (child.tokens_total.input.value ?? 0), 0),
      ownOutput + node.children.reduce((sum, child) => sum + (child.tokens_total.output.value ?? 0), 0),
    );
    node.llm_call_count = metric(
      ownCalls.length + node.children.reduce((sum, child) => sum + (child.llm_call_count.value ?? 0), 0),
    );
    const starts = node.execution_events?.filter((event) => event.kind === "tool_start").length ?? 0;
    const childTools = node.children
      .filter((child) => child.kind !== "tool")
      .reduce((sum, child) => sum + (child.tool_call_count.value ?? 0), 0);
    const nodeOnlyTools = starts === 0 ? node.children.filter((child) => child.kind === "tool").length : 0;
    node.tool_call_count = metric((node.kind === "tool" ? 1 : starts) + childTools + nodeOnlyTools);
    node.cost_own = cost(ownCost, "USD", undefined, ownCost);
    const descendantsCost = node.children.reduce((sum, child) => sum + (child.cost_total.value ?? 0), 0);
    node.cost_total = cost(ownCost + descendantsCost, "USD", undefined, ownCost + descendantsCost);
  };

  const root = makeNode({
    node_id: "session-large",
    kind: "session",
    topic: "Large synthetic public workflow",
    start: metric(BASE_TIME),
    end: metric(BASE_TIME + 75_000),
    duration: metric(75_000),
    children: [firstTurn, secondTurn],
  });
  setRollups(root);
  const session = makeSession(root);
  session.id = SESSION;
  session.title = "Large synthetic public workflow";
  session.agent = "synthetic";
  session.mtime = 1;
  session.sources = ["public synthetic fixture generated in frontend/e2e/large-workflow.spec.ts"];
  return session;
}

async function expectNoPageOverflow(page: import("@playwright/test").Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document, "page-wide horizontal overflow").toBeLessThanOrEqual(widths.viewport);
}

test("large public synthetic workflow stays inspectable on phone and desktop", async ({ page }, testInfo) => {
  const session = makeLargeWorkflow();
  const turns = session.root.children;
  const allCalls = turns.reduce((sum, turn) => sum + turn.llm_calls.length, 0) + 3;
  const allTools = turns.reduce((sum, turn) => sum + (turn.execution_events?.length ?? 0) / 2, 0);
  expect(allCalls).toBeGreaterThanOrEqual(50);
  expect(allTools).toBeGreaterThanOrEqual(60);

  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }),
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  await expect(page.getByRole("heading", { name: "Large synthetic public workflow" })).toBeVisible();
  const turnRow = page.getByTestId("tree-row-turn-large-1");
  const triangle = page.getByTestId("toggle-turn-large-1");
  const triangleBox = await triangle.boundingBox();
  if (triangleBox === null) throw new Error("large workflow triangle has no visible bounds");
  expect(triangleBox.width).toBeGreaterThanOrEqual(18);
  expect(triangleBox.height).toBeGreaterThanOrEqual(18);
  expect(triangleBox.x).toBeGreaterThanOrEqual(0);
  expect(triangleBox.x + triangleBox.width).toBeLessThanOrEqual(1440);
  await expect(turnRow).toBeVisible();
  const treeRowBox = await turnRow.boundingBox();
  if (treeRowBox === null) throw new Error("large workflow tree row has no visible bounds");
  expect(treeRowBox.height).toBeLessThanOrEqual(30);
  if ((await triangle.getAttribute("aria-expanded")) === "false") await triangle.click();
  await expect(page.getByTestId("tree-row-agent-nested-review")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("large-desktop-workflow-tree.png"), fullPage: false });
  await expectNoPageOverflow(page);

  await page
    .getByTestId("tree-row-turn-large-1")
    .getByRole("link", { name: "Show details: Map the large codebase", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await openDisclosure(dialog.getByTestId("workflow-calls"));
  const calls = dialog.getByRole("tabpanel");
  const callRows = calls.locator('tr[data-testid^="call-cost-turn-large-1-"]');
  await expect(callRows).toHaveCount(32);
  await page.screenshot({ path: testInfo.outputPath("large-desktop-calls-overview.png"), fullPage: false });
  while (await calls.getByRole("button", { name: /^Expand \d+ tools$/ }).count()) {
    await calls
      .getByRole("button", { name: /^Expand \d+ tools$/ })
      .first()
      .click();
  }
  const projectedTools = calls.locator('tr[data-testid^="tool-execution-turn-large-1-"]');
  await expect(projectedTools).toHaveCount(40);
  const firstInvocation = calls.getByTestId("tool-execution-turn-large-1-subject:tool-001");
  await expect(firstInvocation).toHaveCount(1);
  const failedInvocation = calls.getByTestId("tool-execution-turn-large-1-subject:tool-017");
  await expect(failedInvocation).toContainText("failed");
  await expect(firstInvocation.getByRole("button", { name: "Collapse Read" })).toBeVisible();
  const sourceEvidence = firstInvocation.locator("xpath=following-sibling::tr[1]");
  await expect(sourceEvidence.getByText("Source evidence", { exact: true })).toHaveCount(0);
  await expect(sourceEvidence.getByText("Requester", { exact: true })).toBeVisible();
  await expect(sourceEvidence.getByRole("link", { name: "LLM call 1", exact: true })).toBeVisible();

  expect(
    session.root.children[0].execution_events?.find((event) => event.event_id === "tool-result:invocation-tool-001")
      ?.start.value,
  ).toBeGreaterThan(session.root.children[0].llm_calls[2].start.value ?? 0);
  await expect(sourceEvidence.getByText("Result user", { exact: true })).toBeVisible();
  await expect(sourceEvidence.getByRole("link", { name: "LLM call 3", exact: true })).toBeVisible();
  const finalCall = calls.getByTestId("call-cost-turn-large-1-2");
  const finalCallTime = await finalCall.locator('td[data-label="Time"]').innerText();
  expect(finalCallTime).toBeTruthy();
  await firstInvocation.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Inspection actions" });
  await expect(menu.getByRole("menuitem", { name: /Show consuming call:/ })).toBeVisible();
  await page.keyboard.press("Escape");

  const callRowBox = await calls.getByTestId("call-cost-turn-large-1-0").boundingBox();
  if (callRowBox === null) throw new Error("desktop call row has no visible bounds");
  // Keep the current row compact; the increment 3 baseline action cluster could wrap in its 170 px time cell.
  // This is a 40 px ceiling, not a measured before/after baseline comparison.
  expect(callRowBox.height).toBeLessThanOrEqual(40);
  await expect(calls.locator('tr[data-testid^="call-cost-"] button[aria-label^="Show details:"]')).toHaveCount(0);
  await expect(calls.getByTestId("call-cost-turn-large-1-0").locator('td[data-label="Item"]')).toHaveText("LLM call 1");
  await failedInvocation.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("large-desktop-calls.png"), fullPage: false });

  await firstInvocation.click({ button: "right" });
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  if (menuBox === null) throw new Error("inspection menu has no visible bounds");
  expect(menuBox.width).toBeGreaterThan(0);
  expect(menuBox.height).toBeGreaterThan(0);
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.y).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1440);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(900);
  await page.keyboard.press("Escape");
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}`);
  const phoneTriangle = page.getByTestId("toggle-turn-large-1");
  await phoneTriangle.scrollIntoViewIfNeeded();
  const phoneTriangleBox = await phoneTriangle.boundingBox();
  if (phoneTriangleBox === null) throw new Error("phone workflow triangle has no visible bounds");
  expect(phoneTriangleBox.width).toBeGreaterThanOrEqual(18);
  expect(phoneTriangleBox.height).toBeGreaterThanOrEqual(18);
  expect(phoneTriangleBox.x + phoneTriangleBox.width).toBeLessThanOrEqual(390);
  const phoneTurnDetails = page
    .getByTestId("tree-row-turn-large-1")
    .getByRole("link", { name: "Show details: Map the large codebase", exact: true });
  await phoneTurnDetails.scrollIntoViewIfNeeded();
  const phoneTurnDetailsBox = await phoneTurnDetails.boundingBox();
  if (phoneTurnDetailsBox === null) throw new Error("phone tree details icon has no visible bounds");
  expect(phoneTurnDetailsBox.width).toBeGreaterThan(0);
  expect(phoneTurnDetailsBox.height).toBeGreaterThan(0);
  expect(phoneTurnDetailsBox.x).toBeGreaterThanOrEqual(0);
  expect(phoneTurnDetailsBox.x + phoneTurnDetailsBox.width).toBeLessThanOrEqual(390);
  await expect(page.getByTestId("tree-row-agent-nested-review")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("large-phone-workflow-tree.png"), fullPage: false });
  await phoneTurnDetails.click();
  const phoneDialog = page.getByRole("dialog");
  await phoneDialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await openDisclosure(phoneDialog.getByTestId("workflow-calls"));
  const phoneCalls = phoneDialog.getByRole("tabpanel");
  await expect(phoneCalls.locator('tr[data-testid^="call-cost-turn-large-1-"]')).toHaveCount(32);
  await page.screenshot({ path: testInfo.outputPath("large-phone-calls-overview.png"), fullPage: false });
  while (await phoneCalls.getByRole("button", { name: /^Expand \d+ tools$/ }).count()) {
    await phoneCalls
      .getByRole("button", { name: /^Expand \d+ tools$/ })
      .first()
      .click();
  }
  await expect(phoneCalls.locator('tr[data-testid^="tool-execution-turn-large-1-"]')).toHaveCount(40);
  const phoneTool = phoneCalls.getByTestId("tool-execution-turn-large-1-subject:tool-001");
  await phoneTool.scrollIntoViewIfNeeded();
  const phoneToolToggle = phoneTool.getByRole("button", { name: "Collapse Read" });
  const phoneToggleBox = await phoneToolToggle.boundingBox();
  if (phoneToggleBox === null) throw new Error("phone tool expansion triangle has no visible bounds");
  expect(phoneToggleBox.width).toBeGreaterThan(0);
  expect(phoneToggleBox.height).toBeGreaterThan(0);
  expect(phoneToggleBox.x).toBeGreaterThanOrEqual(0);
  expect(phoneToggleBox.x + phoneToggleBox.width).toBeLessThanOrEqual(390);
  const phoneScroll = phoneCalls.getByTestId("calls-scroll-turn-large-1");
  expect(await phoneScroll.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
  expect((await phoneTool.boundingBox())?.height).toBeLessThanOrEqual(32);
  await expect(phoneTool.locator('td[data-label="Item"]')).toHaveText(/Read\s*success/i);
  await expect(phoneCalls.locator('button[aria-label^="Show details:"]')).toHaveCount(0);
  const phoneTimestamp = phoneCalls
    .getByTestId("tool-execution-turn-large-1-subject:tool-001")
    .locator('td[data-label="Time"]');
  await expect(phoneTimestamp).toBeVisible();
  const timestampLabel = phoneTimestamp.locator(".mantine-Text-root").first();
  await expect(timestampLabel).not.toHaveText("–");
  expect(
    await timestampLabel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    "phone timestamp text is not clipped",
  ).toBe(true);
  const timestampBounds = await phoneTimestamp.boundingBox();
  if (timestampBounds === null) throw new Error("phone tool timestamp has no visible bounds");
  expect(timestampBounds.width).toBeGreaterThan(0);
  expect(timestampBounds.height).toBeGreaterThan(0);
  expect(timestampBounds.x).toBeGreaterThanOrEqual(0);
  expect(timestampBounds.x + timestampBounds.width).toBeLessThanOrEqual(390);
  const phoneToolBox = await phoneTool.boundingBox();
  if (phoneToolBox === null) throw new Error("phone tool invocation has no visible bounds");
  const menuX = phoneToolBox.x + Math.min(30, phoneToolBox.width / 2);
  const menuY = phoneToolBox.y + Math.min(20, phoneToolBox.height / 2);
  await phoneTool.dispatchEvent("pointerdown", { pointerType: "touch", clientX: menuX, clientY: menuY });
  await page.waitForTimeout(550);
  const phoneMenu = page.getByRole("menu", { name: "Inspection actions" });
  await expect(phoneMenu).toBeVisible();
  const phoneMenuBox = await phoneMenu.boundingBox();
  if (phoneMenuBox === null) throw new Error("phone inspection menu has no visible bounds");
  expect(phoneMenuBox.width).toBeGreaterThan(0);
  expect(phoneMenuBox.height).toBeGreaterThan(0);
  expect(phoneMenuBox.x).toBeGreaterThanOrEqual(0);
  expect(phoneMenuBox.y).toBeGreaterThanOrEqual(0);
  expect(phoneMenuBox.x + phoneMenuBox.width).toBeLessThanOrEqual(390);
  expect(phoneMenuBox.y + phoneMenuBox.height).toBeLessThanOrEqual(844);
  await phoneTool.dispatchEvent("pointerup", { pointerType: "touch", clientX: menuX, clientY: menuY });
  await page.keyboard.press("Escape");
  await page.screenshot({ path: testInfo.outputPath("large-phone-calls.png"), fullPage: false });
  await expectNoPageOverflow(page);
});
