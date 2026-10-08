// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, type Locator, type Page, test } from "@playwright/test";
import type { LlmCallOut, NodeOut, SessionOut } from "../src/api/types";
import {
  cost,
  makeCall,
  makeExecutionEvent,
  makeNode,
  makeSummary,
  makeTool,
  metric,
  tokens,
} from "../src/test/factories";

const SESSION = "claude-code:11111111-1111-4111-8111-111111111111";

async function openDisclosure(dialog: Locator, testId: "workflow-calls" | "workflow-children"): Promise<void> {
  const disclosure = dialog.getByTestId(testId);
  if ((await disclosure.getAttribute("open")) === null) await disclosure.locator("summary").click();
}
const sessionUrl = (params: Record<string, string> = {}) => {
  const query = new URLSearchParams(params);
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return `/sessions/${encodeURIComponent(SESSION)}${suffix}`;
};

async function installReadResultEvent(page: Page): Promise<void> {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = session.root.children.find((child) => child.node_id === "u1");
    if (turn === undefined) throw new Error("The browser fixture has no u1 turn");
    const call = turn.llm_calls[1];
    if (call === undefined) throw new Error("The browser fixture has no second call");
    call.source_request_id = "read-source-request";
    turn.execution_events = [
      makeExecutionEvent({
        event_id: "tool-result:selection-read-result",
        kind: "tool_result",
        subject_node_id: "toolu_read1",
        start: metric((call.start.value ?? 0) + 100),
        links: [
          { owner_id: "u1", source_request_id: call.source_request_id, relation: "requested_by", evidence: "recorded" },
        ],
      }),
    ];
    await route.fulfill({ response, json: session });
  });
}

function makeSelectionCalls(template: LlmCallOut, start: number): LlmCallOut[] {
  return Array.from({ length: 40 }, (_, index) =>
    makeCall({
      ...structuredClone(template),
      call_id: `selection-fixture-${index}`,
      start: metric(start + index * 1000),
      duration: metric(100),
      tokens: { ...template.tokens, ...tokens(100 + index, 10) },
      cost: cost(index / 100, "USD"),
    }),
  );
}

function selectionTurn(session: SessionOut): NodeOut {
  const turn = session.root.children.find((child) => child.node_id === "u1");
  if (turn === undefined) throw new Error("The browser fixture has no u1 turn");
  return turn;
}

async function installSelectionEventSource(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class TestEventSource extends EventTarget {
      url: string;
      withCredentials = false;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private listener = (event: Event) => {
        const update = event as CustomEvent<string>;
        this.dispatchEvent(new MessageEvent("updated", { data: update.detail }));
      };
      constructor(url: string) {
        super();
        this.url = url;
        window.addEventListener("selection-test-updated", this.listener);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      close() {
        this.readyState = 2;
        window.removeEventListener("selection-test-updated", this.listener);
      }
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: TestEventSource });
  });
}

async function dispatchSelectionUpdate(page: Page, summary: ReturnType<typeof makeSummary>): Promise<void> {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent("selection-test-updated", { detail: JSON.stringify(detail) }));
  }, summary);
}

test("replaces one durable mark at a time and Escape clears it without navigation", async ({ page }) => {
  await page.goto(sessionUrl({ sel: "node", entity: "toolu_read1" }));
  await page.getByTestId("tree-row-u1").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("entity")).toBe("u1");
  await page.keyboard.press("Escape");
  const params = new URLSearchParams(new URL(page.url()).search);
  expect(params.has("node")).toBe(false);
  expect(params.has("sel")).toBe(false);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("reopens a reserved native call ID from its encoded deep link after reload", async ({ page }) => {
  const reservedCallId = "native:/?&#%+ with space";
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = selectionTurn(session);
    turn.llm_calls[0].call_id = reservedCallId;
    await route.fulfill({ response, json: session });
  });

  const params = new URLSearchParams({
    node: "u1",
    tab: "workflow",
    sel: "call",
    owner: "u1",
    call: `id:${reservedCallId}`,
  });
  const deepLink = `/sessions/${encodeURIComponent(SESSION)}?${params.toString()}`;
  await page.goto(deepLink);

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "Workflow" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "exact");
  await expect(dialog.getByRole("button", { name: "Collapse LLM call 1" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("dialog").getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "exact");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Collapse LLM call 1" })).toBeVisible();
});

test("a selection-only deep link does not expand ancestors or open an inspection drawer", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl({ sel: "node", entity: "toolu_agent2" }));
  await expect(page.getByTestId("tree-row-u1")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("toggle-toolu_agent1")).toHaveAttribute("aria-label", "Expand");
  await expect(page.getByTestId("tree-row-toolu_agent2")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("node")).toBe(false);
});

test("remembers drawer tabs for each inspected node across navigation", async ({ page }) => {
  await page.goto(sessionUrl({ node: "session", tab: "workflow" }));
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog, "workflow-children");
  await dialog
    .getByTestId("turn-u1")
    .getByRole("link", { name: /Show details:/ })
    .click();
  await expect(page).toHaveURL(/node=u1/);
  await page.getByRole("button", { name: "To parent" }).click();
  await expect(dialog.getByRole("tab", { name: "Workflow" })).toHaveAttribute("aria-selected", "true");
  expect(new URL(page.url()).searchParams.get("tab")).toBe("workflow");
});

test("remembers a node's displayed tab when explicitly opening a child", async ({ page }) => {
  await page.goto(sessionUrl({ node: "session" }));
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  await openDisclosure(dialog, "workflow-children");
  await dialog
    .getByRole("tabpanel")
    .getByTestId("turn-u1")
    .getByRole("link", { name: /Show details:/ })
    .click();
  await expect(page).toHaveURL(/node=u1/);
  await page.getByRole("button", { name: "To parent" }).click();
  await expect(dialog.getByRole("tab", { name: "Workflow" })).toHaveAttribute("aria-selected", "true");
  expect(new URL(page.url()).searchParams.get("tab")).toBe("workflow");
});

test("keeps expanded call rows when navigating to a tool and back to the inspected node", async ({ page }) => {
  await installReadResultEvent(page);
  await page.goto(sessionUrl({ node: "session", tab: "workflow" }));
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog, "workflow-calls");

  const callsPanel = dialog.getByTestId("workflow-calls");
  await callsPanel.getByTestId("expand-call-turn-u1").click();
  await expect(callsPanel.getByRole("button", { name: "Expand LLM call 2" })).toBeVisible();
  await callsPanel.getByRole("button", { name: "Expand LLM call 2" }).click();
  const invocation = callsPanel.getByTestId("tool-execution-u1-subject:toolu_read1");
  await invocation.getByRole("button", { name: "Expand Read" }).click();
  await invocation.locator("xpath=following-sibling::tr[1]").getByRole("link", { name: "Open tool details" }).click();
  await expect(dialog.getByRole("tab", { name: "Content" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "To parent" }).click();
  const parentCalls = dialog.getByTestId("workflow-calls");
  await expect(parentCalls.getByRole("button", { name: "Collapse LLM call 2" })).toBeVisible();
});

test("keeps the desktop drawer width when navigating to a tool and back", async ({ page }) => {
  await installReadResultEvent(page);
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog, "workflow-calls");
  await dialog.getByLabel("Detail width").fill("82");
  const expectedWidth = await dialog.evaluate((element) => Math.round(element.getBoundingClientRect().width));
  await dialog.getByRole("button", { name: "Expand LLM call 2" }).click();
  await openDisclosure(dialog, "workflow-calls");

  const calls = dialog.getByTestId("workflow-calls");
  const invocation = calls.getByTestId("tool-execution-u1-subject:toolu_read1");
  await invocation.getByRole("button", { name: "Expand Read" }).click();
  await invocation.locator("xpath=following-sibling::tr[1]").getByRole("link", { name: "Open tool details" }).click();
  await page.getByRole("button", { name: "To parent" }).click();
  await expect(dialog).toHaveJSProperty("offsetWidth", expectedWidth);
});

test("keeps Workflow and Calls expansion state independent for the same child rows", async ({ page }) => {
  await page.goto(sessionUrl({ node: "session", tab: "workflow" }));
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog, "workflow-children");
  const children = dialog.getByTestId("workflow-children");
  await children.getByTestId("expand-calls-u1").click();
  await expect(children.getByTestId("call-cost-u1-0")).toBeVisible();
  await openDisclosure(dialog, "workflow-calls");

  const callsPanel = dialog.getByTestId("workflow-calls");
  await expect(callsPanel).toBeVisible();
  await expect(callsPanel.getByTestId("expand-call-turn-u1")).toHaveAttribute("aria-expanded", "false");
  await callsPanel.getByTestId("expand-call-turn-u1").click();
  await expect(callsPanel.getByTestId("call-cost-u1-0")).toBeVisible();
  await expect(children.getByTestId("expand-calls-u1")).toHaveAttribute("aria-expanded", "true");
});

test("restores the Workflow reading position after navigating into a child", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    const template = turn.llm_calls[0];
    turn.llm_calls = Array.from({ length: 40 }, (_, index) => ({
      ...structuredClone(template),
      call_id: `selection-fixture-${index}`,
      start: { value: turn.start.value + index * 1000, provenance: "exact" },
      duration: { value: 100, provenance: "exact" },
      tokens: {
        ...template.tokens,
        input: { value: 100 + index, provenance: "exact" },
        output: { value: 10, provenance: "exact" },
      },
      cost: { ...template.cost, value: index / 100, usd: index / 100, provenance: "exact" },
    }));
    turn.end = { value: turn.start.value + 50000, provenance: "exact" };
    session.root.end = { value: turn.start.value + 50000, provenance: "exact" };
    await route.fulfill({ response, json: session });
  });

  await page.goto(sessionUrl({ node: "session", tab: "workflow" }));
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog, "workflow-calls");
  const calls = dialog.getByTestId("workflow-calls");
  const workflowPanel = dialog.getByRole("tabpanel", { name: "Workflow" });
  await calls.getByTestId("expand-call-turn-u1").click();
  const lastCall = calls.getByTestId("call-cost-u1-39");
  await expect(lastCall).toBeVisible();
  await openDisclosure(dialog, "workflow-children");
  const childDetails = workflowPanel.getByTestId("turn-u1").getByRole("link", { name: /Show details:/ });
  await childDetails.scrollIntoViewIfNeeded();
  const readingPosition = await workflowPanel.evaluate((panel) => panel.scrollTop);
  await childDetails.click();
  await expect(page.getByRole("button", { name: "To parent" })).toBeVisible();
  await page.getByRole("button", { name: "To parent" }).click();
  await expect(dialog.getByTestId("workflow-calls")).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Workflow" })).toHaveAttribute("aria-selected", "true");
  const restoredPosition = await workflowPanel.evaluate((panel) => panel.scrollTop);
  expect(Math.abs(restoredPosition - readingPosition)).toBeLessThanOrEqual(2);
});

test("restores tree and call table state from browser history", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = selectionTurn(session);
    turn.llm_calls = makeSelectionCalls(turn.llm_calls[0], turn.start.value ?? 0);
    turn.end = metric((turn.start.value ?? 0) + 50000);
    session.root.end = metric((turn.start.value ?? 0) + 50000);
    session.root.children = [
      turn,
      ...Array.from({ length: 40 }, (_, index) => ({
        ...structuredClone(turn),
        node_id: `selection-turn-${index}`,
        topic: `Selection turn ${index}`,
        children: [],
      })),
    ];
    await route.fulfill({ response, json: session });
  });

  await page.goto(sessionUrl({ node: "session", tab: "workflow" }));
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog, "workflow-calls");
  const calls = dialog.getByRole("tabpanel", { name: "Workflow" });
  const turnToggle = calls.getByTestId("expand-call-turn-u1");
  await expect(turnToggle).toHaveAttribute("aria-expanded", "false");
  await turnToggle.click();
  await page.getByTestId("tree-row-u1").scrollIntoViewIfNeeded();
  const treeScroller = page.getByTestId("tree-row-u1").locator("xpath=../..");
  await calls.getByRole("button", { name: "Expand LLM call 20" }).click();
  await expect(calls.getByRole("button", { name: "Collapse LLM call 20" })).toBeVisible();
  await calls.evaluate((element) => {
    element.scrollTop = 600;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => calls.evaluate((element) => element.scrollTop)).toBe(600);
  await treeScroller.evaluate((element) => {
    element.scrollTop = 30;
  });
  await expect.poll(() => treeScroller.evaluate((element) => element.scrollTop)).toBe(30);

  const childDetails = calls.getByTestId("call-turn-u1").getByRole("link", { name: /Show details:/ });
  await childDetails.scrollIntoViewIfNeeded();
  const readingPosition = await calls.evaluate((element) => element.scrollTop);
  await childDetails.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  await expect(dialog.getByRole("button", { name: "To parent" })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("session");
  await expect(dialog.getByRole("button", { name: "To parent" })).toHaveCount(0);
  await expect(calls.getByTestId("expand-call-turn-u1")).toHaveAttribute("aria-expanded", "true");
  await expect(calls.getByRole("button", { name: "Collapse LLM call 20" })).toBeVisible();
  await expect.poll(() => calls.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(Math.abs((await calls.evaluate((element) => element.scrollTop)) - readingPosition)).toBeLessThanOrEqual(2);
  await expect.poll(() => treeScroller.evaluate((element) => element.scrollTop)).toBe(30);
  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  await expect(dialog.getByRole("button", { name: "To parent" })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
});

test("keeps a collapsed call closed when a newer session update refetches the tree", async ({ page }) => {
  const fixture: { current: SessionOut | null } = { current: null };
  await installSelectionEventSource(page);
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    if (fixture.current === null) {
      const response = await route.fetch();
      fixture.current = (await response.json()) as SessionOut;
      const turn = selectionTurn(fixture.current);
      turn.llm_calls = makeSelectionCalls(turn.llm_calls[0], turn.start.value ?? 0);
      turn.end = metric((turn.start.value ?? 0) + 50000);
      fixture.current.root.end = metric((turn.start.value ?? 0) + 50000);
    }
    await route.fulfill({ json: fixture.current });
  });
  await page.goto(
    sessionUrl({ node: "u1", tab: "workflow", sel: "call", owner: "u1", call: "id:selection-fixture-19" }),
  );
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog, "workflow-calls");

  const calls = dialog.getByTestId("workflow-calls");
  const workflowPanel = dialog.getByRole("tabpanel", { name: "Workflow" });
  const collapse = dialog.getByRole("button", { name: "Collapse LLM call 20" });
  await expect(collapse).toBeVisible();
  await collapse.click();
  await expect(dialog.getByRole("button", { name: "Expand LLM call 20" })).toBeVisible();
  await workflowPanel.evaluate((element) => {
    element.scrollTop = 420;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => workflowPanel.evaluate((element) => element.scrollTop)).toBe(420);
  await openDisclosure(dialog, "workflow-children");
  const workflows = dialog.getByTestId("workflow-children");
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  await expect(workflows).toBeVisible();
  const agentToggle = workflows.getByTestId("expand-calls-toolu_agent1");
  await agentToggle.click();
  await expect(agentToggle).toHaveAttribute("aria-expanded", "true");
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  await expect(calls).toBeVisible();
  await expect.poll(() => workflowPanel.evaluate((element) => element.scrollTop)).toBe(420);
  await expect(calls.getByTestId("call-cost-u1-19")).toBeVisible();
  await expect(calls.getByTestId("call-cost-u1-19").getByRole("button", { name: "Expand LLM call 20" })).toBeVisible();

  if (fixture.current === null) throw new Error("The live fixture was not initialized");
  const turn = selectionTurn(fixture.current);
  const moved = turn.llm_calls.pop();
  if (moved === undefined) throw new Error("The live fixture has no calls to reorder");
  turn.llm_calls.unshift(moved);
  const changed = turn.llm_calls[20];
  turn.llm_calls[20] = makeCall({
    ...changed,
    duration: metric(2500),
    tokens: { ...changed.tokens, input: metric(9000) },
    cost: cost(9, "USD"),
  });
  turn.llm_calls.push(
    makeCall({
      ...changed,
      call_id: "selection-fixture-40",
      start: metric((turn.start.value ?? 0) + 40000),
      duration: metric(250),
      tokens: tokens(141, 14),
      cost: cost(0.41, "USD"),
    }),
  );
  fixture.current.mtime += 1000;
  await dispatchSelectionUpdate(page, makeSummary({ id: SESSION, mtime: fixture.current.mtime }));
  await expect(calls.getByTestId("call-cost-u1-20")).toContainText("$9.00");
  await expect(calls.getByTestId("call-cost-u1-20")).toContainText("2.5s");
  await expect(calls.getByTestId("call-cost-u1-20")).toContainText("9.0k");
  await expect(calls.getByTestId("call-cost-u1-20")).toHaveAttribute("data-selection", "exact");
  await expect(calls.getByTestId("call-cost-u1-40")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("owner")).toBe("u1");
  expect(new URL(page.url()).searchParams.get("call")).toBe("id:selection-fixture-19");
  expect(new URL(page.url()).searchParams.get("tab")).toBe("workflow");
  await expect(calls).toBeVisible();
  await expect.poll(() => workflowPanel.evaluate((element) => element.scrollTop)).toBe(420);
  await expect(workflows.getByTestId("expand-calls-toolu_agent1")).toHaveAttribute("aria-expanded", "true");
  await expect(calls.getByTestId("call-cost-u1-20")).toHaveAttribute("data-selection", "exact");
  await expect(calls.getByTestId("call-cost-u1-20").getByRole("button", { name: "Expand LLM call 21" })).toBeVisible();
});

test("frontend invalidation clears a snapshot-local mark before call indexes shift", async ({ page }) => {
  const fixture: { current: SessionOut | null } = { current: null };
  await installSelectionEventSource(page);
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    if (fixture.current === null) {
      const response = await route.fetch();
      fixture.current = (await response.json()) as SessionOut;
      const turn = selectionTurn(fixture.current);
      turn.llm_calls[1].call_id = null;
      turn.llm_calls[1].start.provenance = "estimated";
      turn.llm_calls[2].call_id = null;
      turn.llm_calls[2].start.provenance = "estimated";
    }
    await route.fulfill({ json: fixture.current });
  });
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog, "workflow-calls");
  const original = dialog.getByTestId("call-cost-u1-1");
  await original.click();
  await expect(original).toHaveAttribute("data-selection", "exact");

  if (fixture.current === null) throw new Error("The invalidation fixture was not initialized");
  selectionTurn(fixture.current).llm_calls.splice(1, 1);
  fixture.current.mtime += 1000;
  await dispatchSelectionUpdate(page, makeSummary({ id: SESSION, mtime: fixture.current.mtime }));
  const replacement = dialog.getByTestId("call-cost-u1-1");
  await expect(replacement).toBeVisible();
  await expect(replacement).toHaveAttribute("data-selection", "none");
  expect(new URL(page.url()).searchParams.has("sel")).toBe(false);
});

test("frontend invalidation closes an inspection menu when its source row disappears", async ({ page }) => {
  const fixture: { current: SessionOut | null } = { current: null };
  await installSelectionEventSource(page);
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    if (fixture.current === null) {
      const response = await route.fetch();
      fixture.current = (await response.json()) as SessionOut;
    }
    await route.fulfill({ json: fixture.current });
  });
  await page.goto(sessionUrl());
  const row = page.getByTestId("tree-row-u1");
  await row.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toBeVisible();

  if (fixture.current === null) throw new Error("The invalidation fixture was not initialized");
  fixture.current.root.children = fixture.current.root.children.filter((child) => child.node_id !== "u1");
  fixture.current.mtime += 1000;
  await dispatchSelectionUpdate(page, makeSummary({ id: SESSION, mtime: fixture.current.mtime }));
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toHaveCount(0);
});

test("session list filtering preserves the original button-free rows", async ({ page }) => {
  await page.goto("/");
  const row = page.getByTestId(`session-row-${SESSION}`);
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: /Show details/ })).toHaveCount(0);
  await page.getByPlaceholder("Search").fill("no-session-matches-this-filter");
  await expect(row).toHaveCount(0);
});

test("frontend invalidation preserves a unique artifact path mark", async ({ page }) => {
  const fixture: { current: SessionOut | null } = { current: null };
  await installSelectionEventSource(page);
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    if (fixture.current === null) {
      const response = await route.fetch();
      fixture.current = (await response.json()) as SessionOut;
      const turn = selectionTurn(fixture.current);
      const template = turn.children.find((child) => child.kind === "tool");
      if (template?.tool === null || template === undefined) throw new Error("The fixture has no tool node");
      const artifact = structuredClone(template);
      artifact.node_id = "stable-artifact-tool";
      if (artifact.tool === null) throw new Error("The cloned artifact source has no tool metadata");
      artifact.tool.category = "edit";
      artifact.tool.path = "src/stable-path.py";
      artifact.tool.paths = ["src/stable-path.py"];
      artifact.tool.writes_file = true;
      turn.children.push(artifact);
    }
    await route.fulfill({ json: fixture.current });
  });
  await page.goto(sessionUrl({ node: "u1", tab: "content" }));
  const row = page.getByRole("dialog").getByTestId("artifact-src/stable-path.py");
  await row.click();
  await expect(row).toHaveAttribute("data-selection", "local");
  if (fixture.current === null) throw new Error("The artifact fixture was not initialized");
  const artifactTool = selectionTurn(fixture.current).children.find(
    (child) => child.node_id === "stable-artifact-tool",
  );
  if (artifactTool?.tool === null || artifactTool === undefined) throw new Error("The marked artifact disappeared");
  artifactTool.tool.paths.push("src/refetched-path.py");
  fixture.current.mtime += 1000;
  await dispatchSelectionUpdate(page, makeSummary({ id: SESSION, mtime: fixture.current.mtime }));
  await expect(page.getByRole("dialog").getByTestId("artifact-src/refetched-path.py")).toBeVisible();
  await expect(row).toHaveAttribute("data-selection", "local");
});

test("frontend invalidation preserves one uniquely matched finding after sort order shifts", async ({ page }) => {
  const fixture: { current: SessionOut | null } = { current: null };
  const markedMessage = "A safely preserved finding";
  await installSelectionEventSource(page);
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    if (fixture.current === null) {
      const response = await route.fetch();
      fixture.current = (await response.json()) as SessionOut;
      const clearFindings = (node: NodeOut) => {
        node.findings = [];
        node.children.forEach(clearFindings);
      };
      clearFindings(fixture.current.root);
      fixture.current.root.findings.push({
        heuristic_id: "W4",
        node_id: "u1",
        severity: "warning",
        message: markedMessage,
        evidence: {},
        estimated_avoidable_cost: { value: null, unit: null, usd: null, provenance: "n/a" },
      });
    }
    await route.fulfill({ json: fixture.current });
  });
  await page.goto(sessionUrl());
  await page.getByRole("button", { name: /Findings \(/ }).click();
  const row = page.locator("[data-finding-key]").filter({ hasText: markedMessage });
  await row.click();
  await expect(row).toHaveAttribute("data-selection", "local");
  if (fixture.current === null) throw new Error("The finding fixture was not initialized");
  fixture.current.root.findings.push({
    heuristic_id: "A0",
    node_id: "u1",
    severity: "error",
    message: "A finding that sorts before it",
    evidence: {},
    estimated_avoidable_cost: { value: null, unit: null, usd: null, provenance: "n/a" },
  });
  fixture.current.mtime += 1000;
  await dispatchSelectionUpdate(page, makeSummary({ id: SESSION, mtime: fixture.current.mtime }));
  await expect(row).toHaveAttribute("data-selection", "local");
  await expect(row).toHaveAttribute("data-finding-key", "u1:W4:A safely preserved finding:1");
});

test("frontend invalidation expires a mark when duplicate findings collapse to one", async ({ page }) => {
  const fixture: { current: SessionOut | null } = { current: null };
  await installSelectionEventSource(page);
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    if (fixture.current === null) {
      const response = await route.fetch();
      fixture.current = (await response.json()) as SessionOut;
      const clearFindings = (node: NodeOut) => {
        node.findings = [];
        node.children.forEach(clearFindings);
      };
      clearFindings(fixture.current.root);
      const finding = {
        heuristic_id: "W4",
        node_id: "u1",
        severity: "warning",
        message: "An ambiguous duplicate finding",
        evidence: {},
        estimated_avoidable_cost: { value: null, unit: null, usd: null, provenance: "n/a" },
      };
      fixture.current.root.findings.push(structuredClone(finding), structuredClone(finding));
    }
    await route.fulfill({ json: fixture.current });
  });
  await page.goto(sessionUrl());
  await page.getByRole("button", { name: /Findings \(/ }).click();
  const matches = page.locator("[data-finding-key]").filter({ hasText: "An ambiguous duplicate finding" });
  await expect(matches).toHaveCount(2);
  await matches.nth(1).click();
  await expect(matches.nth(1)).toHaveAttribute("data-selection", "local");
  if (fixture.current === null) throw new Error("The duplicate finding fixture was not initialized");
  fixture.current.root.findings.shift();
  fixture.current.mtime += 1000;
  await dispatchSelectionUpdate(page, makeSummary({ id: SESSION, mtime: fixture.current.mtime }));
  const remaining = page.locator("[data-finding-key]").filter({ hasText: "An ambiguous duplicate finding" });
  await expect(remaining).toHaveCount(1);
  await expect(remaining).toHaveAttribute("data-selection", "none");
});

test("duplicate node-only tool subjects remain independent local marks with inline evidence", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = selectionTurn(session);
    turn.execution_events = [];
    turn.children.push(
      makeTool("duplicate-tool", "Read duplicate A", { topic: "Duplicate tool A", start: metric(3_000) }),
      makeTool("duplicate-tool", "Read duplicate B", { topic: "Duplicate tool B", start: metric(4_000) }),
    );
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  await openDisclosure(page.getByRole("dialog"), "workflow-calls");

  const calls = page.getByRole("dialog").getByTestId("workflow-calls");
  await calls.getByLabel("Search calls and tools").fill("Read duplicate");
  for (const label of ["Read duplicate A", "Read duplicate B"]) {
    const row = calls.locator('tr[data-testid^="tool-execution-"]').filter({ hasText: label });
    await expect(row).toHaveCount(1);
    await row.click();
    await expect(row).toHaveAttribute("data-selection", "exact");
    expect(new URL(page.url()).searchParams.has("sel")).toBe(false);
    await row.getByRole("button", { name: `Expand ${label}` }).click();
    const details = row.locator("xpath=following-sibling::tr[1]");
    await expect(details.getByRole("link", { name: "Open tool details" })).toHaveCount(0);
    await expect(details.getByText("Source evidence", { exact: true })).toHaveCount(0);
    await expect(details.getByText("Unavailable", { exact: true })).not.toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  }
  const marked = calls.locator('[data-selection="exact"]');
  await expect(marked).toHaveCount(1);
});

test("search keeps the original contiguous tool group context for a partial match", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = selectionTurn(session);
    turn.execution_events = [];
    turn.children = [
      ...turn.children.filter((child) => child.kind !== "tool"),
      makeTool("special-tool", "Read", {
        topic: "Distinctive source file",
        start: metric((turn.start.value ?? 0) + 100),
      }),
      makeTool("ordinary-tool", "Read", { topic: "Routine source file", start: metric((turn.start.value ?? 0) + 200) }),
    ];
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  await openDisclosure(page.getByRole("dialog"), "workflow-calls");

  const calls = page.getByRole("dialog").getByTestId("workflow-calls");
  await calls.getByLabel("Search calls and tools").fill("distinctive");
  const groupToggle = calls.getByRole("button", { name: "Collapse 1 of 2 tools" });
  const group = groupToggle.locator("xpath=ancestor::tr");
  await expect(group.locator('[data-label="Item"]')).toHaveText("Read");
  await expect(groupToggle).toHaveAttribute("aria-expanded", "true");
  await expect(calls.getByTestId("tool-execution-u1-subject:special-tool")).toBeVisible();
  await expect(calls.getByTestId("tool-execution-u1-subject:ordinary-tool")).toHaveCount(0);
});

test("tool requester menu actions distinguish same-key calls by owner", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = selectionTurn(session);
    const requesterA = makeNode({
      node_id: "requester-a",
      kind: "agent",
      topic: "Same task",
      llm_calls: [makeCall({ call_id: "same-call", source_request_id: "shared-request", start: metric(100) })],
    });
    const requesterB = makeNode({
      node_id: "requester-b",
      kind: "agent",
      topic: "Same task",
      llm_calls: [makeCall({ call_id: "same-call", source_request_id: "shared-request", start: metric(200) })],
    });
    turn.children.push(requesterA, requesterB);
    const subject = turn.children.find((child) => child.kind === "tool");
    if (subject === undefined) throw new Error("The browser fixture has no tool subject");
    turn.execution_events = [
      makeExecutionEvent({
        event_id: "tool-start:owner-qualified-menu",
        kind: "tool_start",
        subject_node_id: subject.node_id,
        start: metric((turn.start.value ?? 0) + 300),
        links: [
          {
            owner_id: requesterA.node_id,
            source_request_id: "shared-request",
            relation: "requested_by",
            evidence: "recorded",
          },
          {
            owner_id: requesterB.node_id,
            source_request_id: "shared-request",
            relation: "requested_by",
            evidence: "recorded",
          },
        ],
      }),
    ];
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  await openDisclosure(page.getByRole("dialog"), "workflow-calls");

  const calls = page.getByRole("dialog").getByTestId("workflow-calls");
  await calls.getByLabel("Search calls and tools").fill("owner-qualified-menu");
  const tool = calls.getByTestId("tool-execution-u1-subject:toolu_read1");
  await tool.getByRole("button", { name: "Expand Read" }).click();
  await expect(tool.locator("xpath=following-sibling::tr[1]").getByText("Requester", { exact: true })).toBeVisible();
  await tool.click({ button: "right" });
  const requestActions = page.getByRole("menu", { name: "Inspection actions" }).getByRole("menuitem", {
    name: /^Show requesting call:/,
  });
  await expect(requestActions).toHaveCount(2);
  await expect(requestActions.nth(0)).toContainText("requester-a");
  await expect(requestActions.nth(1)).toContainText("requester-b");
});

test("reveals an initially selected deep call while keeping the requested drawer owner", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = selectionTurn(session);
    const agent = turn.children.find((child) => child.node_id === "toolu_agent1");
    if (agent === undefined) throw new Error("The browser fixture has no selected sub-agent");
    agent.llm_calls[0].call_id = "selection-deep-call";
    await route.fulfill({ response, json: session });
  });

  await page.goto(
    sessionUrl({
      node: "session",
      tab: "workflow",
      sel: "call",
      owner: "toolu_agent1",
      call: "id:selection-deep-call",
    }),
  );
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "Workflow" })).toHaveAttribute("aria-selected", "true");
  await openDisclosure(dialog, "workflow-children");
  await expect(dialog.getByTestId("turn-u1")).toBeVisible();
  await expect(page.getByTestId("tree-row-toolu_agent1")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("node")).toBe("session");
  expect(new URL(page.url()).searchParams.get("owner")).toBe("toolu_agent1");
});

test("marks a removed selected call unavailable without selecting its neighbor", async ({ page }) => {
  const fixture: { current: SessionOut | null } = { current: null };
  await installSelectionEventSource(page);
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    if (fixture.current === null) {
      const response = await route.fetch();
      fixture.current = (await response.json()) as SessionOut;
      const turn = selectionTurn(fixture.current);
      turn.llm_calls = makeSelectionCalls(turn.llm_calls[0], turn.start.value ?? 0);
      turn.end = metric((turn.start.value ?? 0) + 50000);
      fixture.current.root.end = metric((turn.start.value ?? 0) + 50000);
    }
    await route.fulfill({ json: fixture.current });
  });
  await page.goto(
    sessionUrl({ node: "u1", tab: "workflow", sel: "call", owner: "u1", call: "id:selection-fixture-19" }),
  );
  await expect(page.getByTestId("call-cost-u1-19")).toBeVisible();
  if (fixture.current === null) throw new Error("The live fixture was not initialized");
  selectionTurn(fixture.current).llm_calls.splice(19, 1);
  fixture.current.mtime += 1000;
  await dispatchSelectionUpdate(page, makeSummary({ id: SESSION, mtime: fixture.current.mtime }));

  const dialog = page.getByRole("dialog");
  await expect(page.getByText("Selected item unavailable", { exact: true })).toBeVisible();
  await expect(dialog.getByTestId("workflow-calls").locator('[data-selection="exact"]')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("call")).toBe("id:selection-fixture-19");
});

test("rejects duplicate exact timestamp fallback without selecting either call", async ({ page }) => {
  const baseResponse = await page.request.get(`/api/sessions/${encodeURIComponent(SESSION)}`);
  const baseSession = (await baseResponse.json()) as SessionOut;
  const baseStart = selectionTurn(baseSession).start.value;
  if (baseStart === null) throw new Error("The browser fixture has no exact turn start");
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionOut;
    const turn = selectionTurn(session);
    turn.llm_calls = makeSelectionCalls(turn.llm_calls[0], turn.start.value ?? 0);
    turn.llm_calls[0].call_id = null;
    turn.llm_calls[1].call_id = null;
    turn.llm_calls[1].start = metric(turn.llm_calls[0].start.value);
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl({ node: "u1", tab: "workflow", sel: "call", owner: "u1", call: `time:${baseStart}` }));
  const dialog = page.getByRole("dialog");
  await expect(page.getByText("Selected item unavailable", { exact: true })).toBeVisible();
  await expect(dialog.getByTestId("workflow-calls").locator('[data-selection="exact"]')).toHaveCount(0);
});

test("child row marks locally while its details icon opens the child", async ({ page }) => {
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog, "workflow-children");
  const childRow = dialog.getByTestId("sub-agent-toolu_agent1");
  await childRow.click();
  await expect(dialog.getByRole("tab", { name: "Workflow" })).toHaveAttribute("aria-selected", "true");
  expect(new URL(page.url()).searchParams.get("node")).toBe("u1");
  await expect(childRow).toHaveAttribute("data-selection", "exact");
  await expect(dialog.getByTestId("timeline-row-toolu_agent1")).toHaveAttribute("data-selection", "exact");
  await expect(page.getByTestId("tree-row-toolu_agent1")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("tree-row-u1")).toHaveAttribute("aria-selected", "false");
  await expect(page.getByTestId("tree-row-u1")).toHaveAttribute("data-inspected", "true");
  await page.getByTestId("tree-row-u1").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("tree-row-u1")).toHaveAttribute("data-selection", "none");
  await childRow.getByRole("link", { name: /Show details:/ }).click();
  expect(new URL(page.url()).searchParams.get("node")).toBe("toolu_agent1");
  await expect(dialog.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
});

test("selects a tool without opening it, then opens its content from its own control", async ({ page }) => {
  await installReadResultEvent(page);
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog, "workflow-calls");

  const calls = dialog.getByTestId("workflow-calls");
  const invocation = calls.getByTestId("tool-execution-u1-subject:toolu_read1");
  await invocation.click();
  await expect(invocation).toHaveAttribute("data-selection", "exact");
  await expect.poll(() => new URL(page.url()).searchParams.get("entity")).toBe("toolu_read1");
  await expect.poll(() => new URL(page.url()).searchParams.get("sel")).toBe("node");
  expect(new URL(page.url()).searchParams.get("node")).toBe("u1");
  await invocation.getByRole("button", { name: "Expand Read" }).click();
  await invocation.locator("xpath=following-sibling::tr[1]").getByRole("link", { name: "Open tool details" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("toolu_read1");
  await expect(dialog.getByRole("tab", { name: "Content" })).toHaveAttribute("aria-selected", "true");
});

test("agent summary row marks without opening details", async ({ page }) => {
  await page.goto(sessionUrl());
  const row = page.getByTestId("agent-summary-row-1");
  await row.click();
  expect(new URL(page.url()).searchParams.has("node")).toBe(false);
  await expect(row).toHaveAttribute("data-selection", "exact");
  await row.focus();
  await page.keyboard.press("Space");
  expect(new URL(page.url()).searchParams.has("node")).toBe(false);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("tree topic marks without inspecting it, including keyboard activation", async ({ page }) => {
  await page.goto(sessionUrl());
  const row = page.getByTestId("tree-row-u1");
  await row.click();
  expect(new URL(page.url()).searchParams.has("node")).toBe(false);
  await expect(row).toHaveAttribute("data-selection", "exact");
  await expect(row).toHaveAttribute("data-inspected", "false");
  await row.focus();
  await page.keyboard.press("Enter");
  expect(new URL(page.url()).searchParams.has("node")).toBe(false);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("call marks do not paint their owner agent summary rows", async ({ page }) => {
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  let dialog = page.getByRole("dialog");
  await openDisclosure(dialog, "workflow-calls");
  await dialog.getByTestId("call-cost-u1-0").click();
  await expect(dialog.getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "exact");
  await expect(page.getByTestId("agent-summary-row-1")).toHaveAttribute("data-selection", "none");

  await page.goto(sessionUrl({ node: "toolu_agent1", tab: "workflow" }));
  dialog = page.getByRole("dialog");
  await openDisclosure(dialog, "workflow-calls");
  await dialog.getByTestId("call-cost-toolu_agent1-0").click();
  await expect(dialog.getByTestId("call-cost-toolu_agent1-0")).toHaveAttribute("data-selection", "exact");
  const response = await page.request.get(`/api/sessions/${encodeURIComponent(SESSION)}`);
  const session = await response.json();
  const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
  const childAgent = turn.children.find((child: { node_id: string }) => child.node_id === "toolu_agent1");
  await expect(page.getByTestId(`agent-summary-row-${childAgent.agent_id}`)).toHaveAttribute("data-selection", "none");
  await expect(page.getByTestId("agent-summary-row-1")).toHaveAttribute("data-selection", "none");
});

test("a selected entity is marked without opening the drawer", async ({ page }) => {
  await page.goto(sessionUrl({ sel: "node", entity: "toolu_read1" }));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("entity")).toBe("toolu_read1");
});

test("wraps a long selected topic on a phone and keeps the caption link reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const longTopic = "x".repeat(200);
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    const agent = turn.children.find((child: { node_id: string }) => child.node_id === "toolu_agent1");
    agent.topic = longTopic;
    await route.fulfill({ response, json: session });
  });

  await page.goto(sessionUrl({ sel: "node", entity: "toolu_agent1" }));
  const row = page.getByTestId("tree-row-toolu_agent1");
  await expect(row).toContainText(`${longTopic.slice(0, 99)}…`);
  const details = row.getByRole("link", { name: `Show details: ${longTopic.slice(0, 99)}…` });
  await expect(details).toHaveAttribute("title", longTopic);
  await expect(details).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(details).toBeInViewport();
});

test("shows unavailable selection beside a valid inspected node", async ({ page }) => {
  await page.goto(sessionUrl({ node: "u1", sel: "call", owner: "u1", call: "id:missing" }));
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Selected item unavailable", { exact: true })).toBeVisible();
});

test("closing details keeps the selected entity in the URL", async ({ page }) => {
  await page.goto(sessionUrl({ node: "u1", sel: "node", entity: "toolu_read1" }));
  await page.getByRole("button", { name: "Close details" }).click();
  const params = new URLSearchParams(new URL(page.url()).search);
  expect(params.has("node")).toBe(false);
  expect(params.get("sel")).toBe("node");
  expect(params.get("entity")).toBe("toolu_read1");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("uses Overview for legacy node URLs and Content for direct tool URLs", async ({ page }) => {
  await page.goto(sessionUrl({ node: "u1" }));
  await expect(page.getByRole("dialog").getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.goto(sessionUrl({ node: "toolu_read1" }));
  await expect(page.getByRole("dialog").getByRole("tab", { name: "Content" })).toHaveAttribute("aria-selected", "true");
});

test("falls back from an invalid tool tab and preserves selection", async ({ page }) => {
  await page.goto(sessionUrl({ node: "toolu_read1", tab: "workflow", sel: "node", entity: "toolu_read1" }));
  await expect(page.getByRole("dialog").getByRole("tab", { name: "Content" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Close details" }).click();
  const params = new URLSearchParams(new URL(page.url()).search);
  expect(params.get("sel")).toBe("node");
  expect(params.get("entity")).toBe("toolu_read1");
});

test("preserves malformed selection parameters through tab changes and clears them with Escape", async ({ page }) => {
  await page.goto(sessionUrl({ node: "u1", sel: "broken", entity: "kept" }));
  await page.getByRole("dialog").getByRole("tab", { name: "Workflow" }).click();
  let params = new URLSearchParams(new URL(page.url()).search);
  expect(params.get("sel")).toBe("broken");
  expect(params.get("entity")).toBe("kept");
  await page.getByRole("button", { name: "Close details" }).click();
  params = new URLSearchParams(new URL(page.url()).search);
  expect(params.get("sel")).toBe("broken");
  await page.keyboard.press("Escape");
  params = new URLSearchParams(new URL(page.url()).search);
  expect(params.get("sel")).toBe("broken");
  expect(params.get("entity")).toBe("kept");
});

test("selects and opens a call from the calls panel and keeps turn cost ownership", async ({ page }) => {
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  const dialog = page.getByRole("dialog");
  await openDisclosure(dialog, "workflow-calls");
  const workflow = dialog.getByRole("tabpanel", { name: "Workflow" });
  const calls = dialog.getByTestId("workflow-calls");
  const costBar = workflow.getByTestId("cost-bar-u1-1");
  await expect(costBar).toBeVisible();
  await costBar.click();
  await expect(costBar).toHaveAttribute("data-selection", "exact");
  await expect(calls.getByTestId("call-cost-u1-1")).toHaveAttribute("data-selection", "exact");
  await expect(calls.getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "none");
  expect(new URL(page.url()).searchParams.get("node")).toBe("u1");

  const firstCall = calls.getByTestId("call-cost-u1-0");
  await firstCall.click();
  let params = new URL(page.url()).searchParams;
  expect(params.get("sel")).toBe("call");
  expect(params.get("owner")).toBe("u1");
  expect(params.get("call")).toBeTruthy();
  await firstCall.getByRole("button", { name: "Expand LLM call 1" }).click();
  params = new URL(page.url()).searchParams;
  expect(params.get("sel")).toBe("call");
  await expect(calls.getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "exact");
  await expect(calls.getByTestId("call-cost-u1-1")).toHaveAttribute("data-selection", "none");
  await firstCall.getByRole("button", { name: "Collapse LLM call 1" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(firstCall).toBeVisible();
  const callsScroll = dialog.getByTestId("calls-scroll-u1");
  expect((await callsScroll.boundingBox())?.width).toBeLessThanOrEqual(358);
  await expect.poll(() => callsScroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect((await firstCall.boundingBox())?.height).toBeLessThanOrEqual(32);
  await firstCall.click({ button: "right" });
  await page
    .getByRole("menu", { name: "Inspection actions" })
    .getByRole("menuitem", { name: "Show details", exact: true })
    .click();
  await expect(firstCall.getByRole("button", { name: "Collapse LLM call 1" })).toBeVisible();

  await page.goto(sessionUrl({ node: "session", tab: "workflow" }));
  const sessionDialog = page.getByRole("dialog");
  await openDisclosure(sessionDialog, "workflow-calls");

  const callsPanel = sessionDialog.getByTestId("workflow-calls");
  await sessionDialog.getByRole("tabpanel", { name: "Workflow" }).getByTestId("cost-bar-u1-1").click();
  await expect(callsPanel.getByTestId("call-turn-u1")).toBeVisible();
  await callsPanel.getByTestId("expand-call-turn-u1").click();
  await expect(callsPanel.getByTestId("call-cost-u1-1")).toHaveAttribute("data-selection", "exact");

  await expect(callsPanel.getByTestId("call-cost-u1-1")).toHaveAttribute("data-selection", "exact");
});

test("keeps calls inspectable when a call has no stable identity", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    turn.llm_calls[1].call_id = null;
    turn.llm_calls[1].start.provenance = "estimated";
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  const dialog = page.getByRole("dialog");
  const callsDisclosure = dialog.getByTestId("workflow-calls");
  if ((await callsDisclosure.getAttribute("open")) !== null) await callsDisclosure.locator("summary").click();
  await expect(callsDisclosure).not.toHaveAttribute("open");
  const unaddressableCostBar = dialog.getByTestId("cost-bar-u1-1");
  await expect(unaddressableCostBar).toBeEnabled();
  await unaddressableCostBar.click();
  await expect(unaddressableCostBar).toHaveAttribute("data-selection", "exact");
  expect(new URL(page.url()).searchParams.has("sel")).toBe(false);
  await expect(callsDisclosure).not.toHaveAttribute("open");
  await openDisclosure(dialog, "workflow-calls");
  await expect(dialog.getByTestId("call-cost-u1-1")).toBeVisible();
  await expect(dialog.getByTestId("call-cost-u1-1").getByRole("button", { name: "Expand LLM call 2" })).toBeVisible();
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  const timelineMark = dialog.getByTestId("track-u1").getByTestId("timeline-call-u1-1");
  await expect(timelineMark).toHaveAttribute("data-selection", "exact");
  await expect(timelineMark).toHaveAttribute("aria-pressed", "true");
  expect(new URL(page.url()).searchParams.has("sel")).toBe(false);
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  await dialog.getByRole("button", { name: "Expand LLM call 2" }).click();
  await expect(dialog.getByTestId("mobile-call-metrics-u1-1")).toHaveCount(1);
});

test("reveals a deep-linked turn call in the workflow panel without changing tabs", async ({ page }) => {
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  await openDisclosure(page.getByRole("dialog"), "workflow-calls");
  await page.getByRole("dialog").getByTestId("call-cost-u1-0").click();
  const params = new URL(page.url()).searchParams;
  params.set("node", "session");
  params.set("tab", "workflow");
  await page.goto(`${new URL(page.url()).pathname}?${params.toString()}`);

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "Workflow" })).toHaveAttribute("aria-selected", "true");
  const children = dialog.getByTestId("workflow-children");
  const calls = dialog.getByTestId("workflow-calls");
  await openDisclosure(dialog, "workflow-children");
  await expect(children.getByTestId("turn-u1")).toBeVisible();
  await expect(children.getByTestId("expand-calls-u1")).toHaveAttribute("aria-expanded", "true");
  await expect(children.getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "exact");
  await expect(calls.getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "exact");
  await expect(calls.getByTestId("call-cost-u1-0")).toBeVisible();
});

test("reveals a selected child-agent call from the workflow panel", async ({ page }) => {
  await page.goto(sessionUrl({ node: "toolu_agent1", tab: "workflow" }));
  await openDisclosure(page.getByRole("dialog"), "workflow-calls");
  await page.getByRole("dialog").getByTestId("call-cost-toolu_agent1-0").click();
  const params = new URL(page.url()).searchParams;
  params.set("node", "u1");
  params.set("tab", "workflow");
  await page.goto(`${new URL(page.url()).pathname}?${params.toString()}`);

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "Workflow" })).toHaveAttribute("aria-selected", "true");
  await openDisclosure(dialog, "workflow-children");
  await expect(dialog.getByTestId("sub-agent-toolu_agent1")).toBeVisible();
  const childCalls = dialog.getByTestId("expand-calls-toolu_agent1");
  if ((await childCalls.getAttribute("aria-expanded")) !== "true") await childCalls.click();
  await expect(childCalls).toHaveAttribute("aria-expanded", "true");
  const workflowCall = dialog.getByTestId("call-cost-toolu_agent1-0").filter({ visible: true });
  await expect(workflowCall).toHaveAttribute("data-selection", "exact");
  await expect(workflowCall).toBeVisible();
});

test("selects a context bar and keeps its exact call selection across tabs", async ({ page }) => {
  await page.goto(sessionUrl({ node: "u1" }));
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  const workflow = dialog.getByLabel("Workflow", { exact: true });
  await workflow.getByRole("button", { name: "Mark context for LLM call 2" }).click();
  await expect(workflow.getByTestId("context-bar-u1-1")).toHaveAttribute("data-selection", "exact");
  expect(new URL(page.url()).searchParams.get("node")).toBe("u1");
  expect(new URL(page.url()).searchParams.get("sel")).toBe("call");
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  await openDisclosure(dialog, "workflow-calls");

  const calls = dialog.getByTestId("workflow-calls");
  await expect(workflow.getByTestId("cost-bar-u1-1")).toHaveAttribute("data-selection", "exact");
  await expect(calls.getByTestId("call-cost-u1-1")).toHaveAttribute("data-selection", "exact");
  await expect(calls.getByTestId("call-cost-u1-0")).toHaveAttribute("data-selection", "none");
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  await expect(workflow).toBeVisible();
  await expect(workflow.getByTestId("timeline-call-u1-1")).toHaveAttribute("data-selection", "exact");
  const previousCallKey = new URL(page.url()).searchParams.get("call");
  const earlierCall = workflow.getByTestId("timeline-call-u1-0");
  const earlierTag = await earlierCall.evaluate((element) => element.tagName);
  if (earlierTag === "BUTTON") {
    await earlierCall.focus();
    await page.keyboard.press("Enter");
  } else {
    const callGroup = workflow.getByTestId("track-u1").locator('[data-hit-testids~="timeline-call-u1-0"]');
    await callGroup.getByRole("button", { name: /Mark overlapping activity/ }).click();
    await expect(callGroup.locator("fieldset")).toHaveAttribute("data-selection", "exact");
    expect(new URL(page.url()).searchParams.get("sel")).toBeNull();
    await callGroup.getByRole("button", { name: /Mark overlapping activity/ }).click({ button: "right" });
    const chooseEarlier = page
      .getByRole("menu", { name: "Inspection actions" })
      .getByRole("menuitem", { name: /^Show details: LLM call 1(?: ·| \()/ });
    await expect(chooseEarlier).toBeVisible();
    await chooseEarlier.click();
  }
  await expect(workflow.getByTestId("timeline-call-u1-0")).toHaveAttribute("data-selection", "exact");
  await expect(workflow.getByTestId("timeline-call-u1-1")).toHaveAttribute("data-selection", "none");
  const nextUrl = new URL(page.url());
  expect(nextUrl.searchParams.get("node")).toBe("u1");
  expect(nextUrl.searchParams.get("sel")).toBe("call");
  expect(nextUrl.searchParams.get("call")).not.toBe(previousCallKey);
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  await expect(dialog.getByLabel("Workflow", { exact: true }).getByTestId("context-bar-u1-0")).toHaveAttribute(
    "data-selection",
    "exact",
  );
});

test("does not create context bars for a side request", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    turn.llm_calls[1].call_id = "side-request";
    turn.llm_calls[1].in_context = false;
    turn.llm_calls[1].tokens.input.value = null;
    turn.llm_calls[1].tokens.cache_read.value = null;
    turn.llm_calls[1].tokens.cache_write.value = null;
    turn.llm_calls[1].cost = { value: null, unit: null, usd: null, provenance: "n/a" };
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl({ node: "u1", sel: "call", owner: "u1", call: "id:side-request" }));
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  await expect(dialog.getByLabel("Workflow", { exact: true }).getByTestId("context-bar-u1-1")).toHaveCount(0);
});

test("keeps an untimed native-ID call selectable without inventing a timeline position", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    turn.llm_calls[1].call_id = "untimed-call";
    turn.llm_calls[1].start.value = null;
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl({ node: "u1", tab: "workflow", sel: "call", owner: "u1", call: "id:untimed-call" }));
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Workflow", { exact: true }).getByTestId("timeline-call-u1-1")).toHaveCount(0);
  await dialog.getByRole("tab", { name: "Workflow" }).click();
  await expect(dialog.getByTestId("call-cost-u1-1")).toHaveAttribute("data-selection", "exact");
});

test("labels a selected call outside the inspected node's own-call scope", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    const agent = turn.children.find((child: { node_id: string }) => child.node_id === "toolu_agent1");
    agent.llm_calls[0].call_id = "outside-call";
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl({ node: "u1", sel: "call", owner: "toolu_agent1", call: "id:outside-call" }));
  const params = new URL(page.url()).searchParams;
  expect(params.get("node")).toBe("u1");
  expect(params.get("owner")).toBe("toolu_agent1");
  expect(params.get("call")).toBe("id:outside-call");
});

test("keeps a call at the timeline end reachable inside the track", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    turn.llm_calls[1].call_id = "boundary-call";
    turn.llm_calls[1].start.value = turn.end.value;
    turn.llm_calls[1].duration.value = null;
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  const workflow = page.getByRole("dialog").getByLabel("Workflow", { exact: true });
  const track = workflow.getByTestId("track-u1");
  const directHit = track.getByRole("button", { name: "Select timeline LLM call 2", exact: true });
  const hasDirectHit = (await directHit.count()) > 0;
  const group = track.locator('[data-hit-testids*="timeline-call-u1-1"]');
  const hitTarget = hasDirectHit ? directHit : group.getByRole("button", { name: /Mark overlapping activity/ });
  const trackBox = await track.boundingBox();
  const markerBox = await hitTarget.boundingBox();
  if (trackBox === null || markerBox === null) throw new Error("Timeline hit target is not measurable");
  expect(markerBox.x + markerBox.width).toBeLessThanOrEqual(trackBox.x + trackBox.width + 1);
  await hitTarget.click();
  if (!hasDirectHit) {
    await group.getByRole("button", { name: /Mark overlapping activity/ }).click({ button: "right" });
    await page
      .getByRole("menu", { name: "Inspection actions" })
      .getByRole("menuitem", { name: /^Show details: LLM call 2 · Fix the parser/ })
      .click();
  }
  expect(new URL(page.url()).searchParams.get("node")).toBe("u1");
  expect(new URL(page.url()).searchParams.get("sel")).toBe("call");
  expect(new URL(page.url()).searchParams.get("owner")).toBe("u1");
  expect(new URL(page.url()).searchParams.get("call")).toBe("id:boundary-call");
});

test("overlapping calls mark only their aggregate until a labeled detail action is chosen", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    turn.start.value = 0;
    turn.end.value = 100;
    turn.llm_calls[0].call_id = "overlap-a";
    turn.llm_calls[0].start.value = 10;
    turn.llm_calls[0].duration.value = 50;
    turn.llm_calls[1].call_id = "overlap-b";
    turn.llm_calls[1].start.value = 20;
    turn.llm_calls[1].duration.value = 60;
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  const workflow = page.getByRole("dialog").getByLabel("Workflow", { exact: true });
  const track = workflow.getByTestId("track-u1");
  const aggregate = track.locator('[data-hit-testids~="timeline-call-u1-0"]');
  const mark = aggregate.getByRole("button", { name: /Mark overlapping activity/ });
  await mark.focus();
  await page.keyboard.press("Enter");
  await expect(aggregate.locator("fieldset")).toHaveAttribute("data-selection", "exact");
  expect(new URL(page.url()).searchParams.get("sel")).toBeNull();
  const details = aggregate.getByRole("button", { name: /Mark overlapping activity/ });
  await details.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Inspection actions" });
  await expect(menu.getByRole("menuitem", { name: /^Show details: LLM call 1 · Fix the parser/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^Show details: LLM call 2 · Fix the parser/ })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(workflow.getByTestId("timeline-call-u1-1")).toHaveAttribute("data-selection", "exact");
  expect(new URL(page.url()).searchParams.get("node")).toBe("u1");
  expect(new URL(page.url()).searchParams.get("call")).toBe("id:overlap-b");
});

test("zoomed activity chooser excludes offscreen merged nodes and keeps visible candidates selectable", async ({
  page,
}) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    const source = turn.children.find((child: { kind: string }) => child.kind === "tool");
    if (source === undefined || source.tool === null) throw new Error("Expected a tool node in the fixture");
    turn.children = turn.children.filter((child: { kind: string }) => child.kind !== "tool");
    for (const [id, start, end] of [
      ["offscreen-tool", 0, 60],
      ["visible-tool-a", 50, 100],
      ["visible-tool-b", 55, 95],
    ] as const) {
      const tool = structuredClone(source);
      tool.node_id = id;
      tool.topic = id;
      tool.start.value = start;
      tool.end.value = end;
      turn.children.push(tool);
    }
    turn.start.value = 0;
    turn.end.value = 100;
    session.root.start.value = 0;
    session.root.end.value = 100;
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl({ tab: "workflow" }));
  const sliders = page.getByRole("slider");
  await sliders.first().focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  for (let index = 0; index < 160; index += 1) await page.keyboard.press("ArrowRight");

  const track = page.getByTestId("track-u1");
  const group = track.locator('[data-hit-testids~="activity-node-visible-tool-a"]');
  const mark = group.getByRole("button", { name: /Mark overlapping activity/ });
  await mark.click();
  await expect(group.locator("fieldset")).toHaveAttribute("data-selection", "exact");
  await group.getByRole("button", { name: /Mark overlapping activity/ }).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Inspection actions" });
  await expect(menu.getByRole("menuitem", { name: "Show details: tool Read: visible-tool-a" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Show details: tool Read: visible-tool-b" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /offscreen-tool/ })).toHaveCount(0);
});

test("merged tool activity marks locally and exposes each explicit candidate action", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    const source = turn.children.find((child: { kind: string }) => child.kind === "tool");
    if (source === undefined || source.tool === null) throw new Error("Expected a tool node in the fixture");
    for (const id of ["merged-a", "merged-b"]) {
      const tool = structuredClone(source);
      tool.node_id = id;
      tool.topic = `Merged tool ${id}`;
      tool.start.value = source.start.value;
      tool.end.value = source.end.value;
      turn.children.push(tool);
    }
    await route.fulfill({ response, json: session });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(sessionUrl({ node: "u1", tab: "workflow" }));
  const dialog = page.getByRole("dialog");
  const workflow = dialog.getByLabel("Workflow", { exact: true });
  const track = workflow.getByTestId("track-u1");
  const aggregate = track.locator('[data-hit-testids~="activity-node-merged-a"]');
  await aggregate.getByRole("button", { name: /Mark overlapping activity/ }).click();
  await expect(aggregate.locator("fieldset")).toHaveAttribute("data-selection", "exact");
  expect(new URL(page.url()).searchParams.get("entity")).toBeNull();
  const details = aggregate.getByRole("button", { name: /Mark overlapping activity/ });
  await details.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Inspection actions" });
  await expect(menu.getByRole("menuitem", { name: "Show details: tool Read: Merged tool merged-a" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Show details: tool Read: Merged tool merged-b" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Show details: tool Read: Merged tool merged-a" }).click();
  expect(new URL(page.url()).searchParams.get("node")).toBe("merged-a");
  await expect(page.getByRole("dialog").getByRole("tab", { name: "Content" })).toHaveAttribute("aria-selected", "true");

  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBe("u1");
  await expect(page.getByRole("dialog")).toBeVisible();
  const restoredAggregate = page
    .getByRole("dialog")
    .getByLabel("Workflow", { exact: true })
    .getByTestId("track-u1")
    .locator('[data-hit-testids~="activity-node-merged-a"]');
  const restoredDetails = restoredAggregate.getByRole("button", {
    name: /Mark overlapping activity/,
  });
  await restoredDetails.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Inspection actions" })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("node")).toBe("u1");
  expect(new URL(page.url()).searchParams.get("tab")).toBe("workflow");
  await restoredDetails.click({ button: "right" });
  await page
    .getByRole("menu", { name: "Inspection actions" })
    .getByRole("menuitem", { name: "Show details: tool Read: Merged tool merged-b" })
    .click();
  expect(new URL(page.url()).searchParams.get("node")).toBe("merged-b");
  await expect(page.getByRole("dialog").getByRole("tab", { name: "Content" })).toHaveAttribute("aria-selected", "true");
});

test("marks an artifact locally and opens an explicit producer candidate", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    const turn = session.root.children.find((child: { node_id: string }) => child.node_id === "u1");
    const source = turn.children.find((child: { kind: string }) => child.kind === "tool");
    if (source === undefined || source.tool === null) throw new Error("Expected a tool node in the fixture");
    for (const [index, id] of ["producer-a", "producer-b"].entries()) {
      const producer = structuredClone(source);
      producer.node_id = id;
      producer.topic = `Write shared.py ${index + 1}`;
      producer.tool.category = "edit";
      producer.tool.native_id = "Write";
      producer.tool.writes_file = index === 0;
      producer.tool.path = "shared.py";
      producer.tool.paths = ["shared.py"];
      producer.start.value = 40 + index;
      producer.end.value = 45 + index;
      turn.children.push(producer);
    }
    await route.fulfill({ response, json: session });
  });
  await page.goto(sessionUrl({ node: "u1", tab: "content" }));
  const dialog = page.getByRole("dialog");
  const artifact = dialog.getByTestId("artifact-shared.py");
  await artifact.click();
  await expect(artifact).toHaveAttribute("data-selection", "local");
  expect(new URL(page.url()).searchParams.get("node")).toBe("u1");
  await artifact.getByRole("link", { name: "Show details: shared.py" }).click();
  const menu = page.getByRole("menu", { name: "Inspection actions" });
  await expect(menu.getByRole("menuitem", { name: /Show producer: Write: Write shared.py 1/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Show producer: Write: Write shared.py 2/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /Show producer: Write: Write shared.py 2/ }).click();
  expect(new URL(page.url()).searchParams.get("node")).toBe("producer-b");
  await expect(page.getByRole("dialog").getByRole("tab", { name: "Content" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Close details" }).click();
  await page.goto(sessionUrl({ node: "u1", tab: "content", sel: "node", entity: "producer-b" }));
  await expect(page.getByTestId("artifact-shared.py")).toHaveAttribute("data-selection", "none");
});
