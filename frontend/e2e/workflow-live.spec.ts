// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, type Locator, type Page, test } from "@playwright/test";
import { makeCall, makeNode, makeSummary, metric } from "../src/test/factories";
import {
  assertNoSelectionActionControls,
  installDeepWorkflow,
  installWorkflowDetail,
  WORKFLOW_SESSION,
} from "./helpers/workflowFixture";
import { workflowStream } from "./helpers/workflowStream";

const sessionUrl = `/sessions/${encodeURIComponent(WORKFLOW_SESSION)}`;

async function waitForStreamConnection(connected: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connected,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Native EventSource did not connect")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function topRowPosition(tree: Locator): Promise<{ id: string | null; offset: number } | null> {
  return tree.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>("[data-testid^='tree-row-']")];
    const row = rows.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top <= bounds.top + 1 && rect.bottom > bounds.top + 1;
    });
    return row === undefined
      ? null
      : { id: row.dataset.nodeId ?? null, offset: bounds.top - row.getBoundingClientRect().top };
  });
}

async function waitForSessionRefresh(page: Page): Promise<void> {
  const response = await page.waitForResponse((candidate) => {
    const pathname = decodeURIComponent(new URL(candidate.url()).pathname);
    return pathname === `/api/sessions/${WORKFLOW_SESSION}` && candidate.request().method() === "GET";
  });
  expect(response.ok()).toBe(true);
}

test("opens the native EventSource over a real streaming HTTP response", async ({ page }) => {
  const stream = await workflowStream();
  try {
    await page.route("**/api/sessions/events", (route) => route.continue({ url: stream.url }));
    await page.goto("/");
    await waitForStreamConnection(stream.connected, test.info().timeout);
    expect(new URL(stream.url).pathname).toBe("/api/sessions/events");
  } finally {
    await stream.close();
  }
});

test("keeps a removed live scope and selection addressable with honest fallback until reset", async ({ page }) => {
  const stream = await workflowStream();
  let initialMtime: number | null = null;
  let sourceRevision = 0;
  let removeFocusedBranch = false;
  try {
    await installDeepWorkflow(page, 20, 0, false, (session) => {
      initialMtime ??= session.mtime;
      session.mtime = (initialMtime ?? 0) + sourceRevision;
      if (removeFocusedBranch) {
        session.root.children = session.root.children.filter((child) => child.node_id !== "turn");
      }
    });
    await installWorkflowDetail(page, "deep-20");
    await page.route("**/api/sessions/events", (route) => route.continue({ url: stream.url }));
    await page.goto(`${sessionUrl}?scope=deep-20&activity=running&node=deep-20&sel=node&entity=deep-20`);
    await expect(page.getByRole("tabpanel", { name: "Overview" })).toContainText("Recorded task for deep-20");
    await assertNoSelectionActionControls(page);
    await waitForStreamConnection(stream.connected, test.info().timeout);

    removeFocusedBranch = true;
    sourceRevision = 1;
    const refresh = waitForSessionRefresh(page);
    stream.emit(makeSummary({ id: WORKFLOW_SESSION, mtime: (initialMtime ?? 0) + sourceRevision }));
    await refresh;
    await expect(page.getByText("Workflow scope unavailable; showing the whole session")).toBeVisible();
    await expect(page.getByText("Selected item unavailable")).toBeVisible();
    await expect(page.getByTestId("tree-row-session")).toBeVisible();
    await expect(page.getByTestId("tree-row-deep-0")).toHaveCount(0);
    await assertNoSelectionActionControls(page);
    const unavailableUrl = new URL(page.url());
    expect(unavailableUrl.searchParams.get("scope")).toBe("deep-20");
    expect(unavailableUrl.searchParams.get("activity")).toBe("running");
    expect(unavailableUrl.searchParams.get("entity")).toBe("deep-20");
    expect(unavailableUrl.searchParams.get("node")).toBe("deep-20");

    await page.getByRole("button", { name: "Whole session" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.has("scope")).toBe(false);
    await expect(page.getByText("Selected item unavailable")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("entity")).toBe("deep-20");
    await assertNoSelectionActionControls(page);
  } finally {
    await stream.close();
  }
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`preserves the visible row and pixel offset across a live prepend at ${viewport.width}px`, async ({ page }) => {
    const stream = await workflowStream();
    let initialMtime: number | null = null;
    let sourceRevision = 0;
    let prepend = false;
    try {
      await page.setViewportSize(viewport);
      await installDeepWorkflow(page, 0, 70, false, (session) => {
        initialMtime ??= session.mtime;
        if (prepend) {
          session.root.children.unshift(makeNode({ node_id: "live-first", kind: "turn", topic: "Live first row" }));
        }
        session.mtime = (initialMtime ?? 0) + sourceRevision;
      });
      await page.route("**/api/sessions/events", (route) => route.continue({ url: stream.url }));
      await page.goto(`/sessions/${encodeURIComponent(WORKFLOW_SESSION)}`);
      const tree = page.getByTestId("tree-scroll");
      await expect(page.getByTestId("tree-row-session")).toBeVisible();
      await tree.evaluate((element) => {
        element.scrollTop = 600;
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      const captureTopRow = () => topRowPosition(tree);
      await expect.poll(captureTopRow).not.toBeNull();
      const before = await captureTopRow();
      expect(before).not.toBeNull();
      await waitForStreamConnection(stream.connected, test.info().timeout);
      prepend = true;
      sourceRevision = 1;
      stream.emit(makeSummary({ id: WORKFLOW_SESSION, mtime: (initialMtime ?? 0) + sourceRevision }));
      await expect(page.getByTestId("tree-row-live-first")).toBeVisible();
      await expect.poll(captureTopRow).toMatchObject({ id: before?.id });
      const after = await captureTopRow();
      expect(after?.offset).toBeCloseTo(before?.offset ?? 0, 0);
    } finally {
      await stream.close();
    }
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`preserves the visible row and pixel offset across a live reorder at ${viewport.width}px`, async ({ page }) => {
    const stream = await workflowStream();
    let initialMtime: number | null = null;
    let sourceRevision = 0;
    let reorder = false;
    let stableIndex = 0;
    try {
      await page.setViewportSize(viewport);
      await installDeepWorkflow(page, 4, 0, false, (session) => {
        initialMtime ??= session.mtime;
        const pending = [session.root];
        let deepZero: typeof session.root | undefined;
        while (pending.length > 0) {
          const node = pending.pop();
          if (node === undefined) continue;
          if (node.node_id === "deep-0") deepZero = node;
          pending.push(...node.children);
        }
        if (deepZero !== undefined && !deepZero.children.some((node) => node.node_id === "reorder-child-0")) {
          deepZero.children.push(
            ...Array.from({ length: 40 }, (_, index) => {
              const node = makeNode({
                node_id: `reorder-child-${index}`,
                kind: "agent",
                agent_id: 1000 + index,
                topic: `Reorder child ${index}`,
                activity: "running",
              });
              if (index === 0) {
                node.llm_calls = Array.from({ length: 20 }, (_, callIndex) =>
                  makeCall({
                    call_id: `reorder-call-${callIndex}`,
                    start: metric(10_000 + callIndex * 1_000),
                    source_stream_id: "reorder-stream",
                    source_order: callIndex,
                  }),
                );
              }
              return node;
            }),
          );
        }
        const callOwner = deepZero?.children.find((node) => node.node_id === "reorder-child-0");
        stableIndex = callOwner?.llm_calls.length === 20 ? 10 : 0;
        if (reorder && deepZero !== undefined) {
          deepZero.children.splice(0, 30, ...deepZero.children.slice(0, 30).reverse());
        }
        session.mtime = (initialMtime ?? 0) + sourceRevision;
      });
      await installWorkflowDetail(page, "reorder-child-0");
      await page.route("**/api/sessions/events", (route) => route.continue({ url: stream.url }));
      await page.goto(`${sessionUrl}?scope=deep-0&activity=running`);
      await assertNoSelectionActionControls(page);
      await page.getByRole("button", { name: "Expand matching paths" }).click();
      await expect(page.getByTestId("tree-row-reorder-child-0")).toBeVisible();
      const slider = page.getByRole("slider").first();
      await slider.focus();
      for (let index = 0; index < 12; index += 1) await page.keyboard.press("ArrowRight");
      const zoomBefore = await slider.getAttribute("aria-valuenow");
      await page
        .getByTestId("tree-row-reorder-child-0")
        .getByRole("link", { name: /Show details:/ })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("tab", { name: "Workflow" }).click();
      const callsDisclosure = dialog.getByTestId("workflow-calls");
      if ((await callsDisclosure.getAttribute("open")) === null) await callsDisclosure.locator("summary").click();
      const selectedCall = dialog.getByTestId(`call-cost-reorder-child-0-${stableIndex}`);
      await selectedCall.click();
      await expect(selectedCall).toHaveAttribute("data-selection", "exact");
      await selectedCall.getByRole("button", { name: /Expand LLM call/ }).click();
      await expect(selectedCall.getByRole("button", { name: /Collapse LLM call/ })).toBeVisible();
      await page.getByRole("button", { name: "Close details" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get("node")).toBeNull();
      expect(new URL(page.url()).searchParams.get("tab")).toBeNull();
      expect(new URL(page.url()).searchParams.get("call")).toBe("id:reorder-call-10");
      const tree = page.getByTestId("tree-scroll");
      await expect(page.getByTestId("tree-row-reorder-child-0")).toBeVisible();
      const rowHeight = viewport.width < 768 ? 176 : 30;
      await tree.evaluate((element, height) => {
        element.scrollTop = height * 25 + 7;
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
      }, rowHeight);
      await expect.poll(() => topRowPosition(tree)).not.toBeNull();
      const before = await topRowPosition(tree);
      expect(before).not.toBeNull();
      expect(before?.id).toBe("reorder-child-20");
      const anchorRow = page.getByTestId("tree-row-reorder-child-20");
      const beforeRowIndex = Number(await anchorRow.getAttribute("aria-rowindex"));
      expect(beforeRowIndex).toBeGreaterThan(0);
      await waitForStreamConnection(stream.connected, test.info().timeout);
      reorder = true;
      sourceRevision = 1;
      const refresh = waitForSessionRefresh(page);
      stream.emit(makeSummary({ id: WORKFLOW_SESSION, mtime: (initialMtime ?? 0) + sourceRevision }));
      await refresh;
      await assertNoSelectionActionControls(page);
      await expect(page.getByTestId("tree-row-reorder-child-0")).toBeAttached();
      await expect.poll(async () => Number(await anchorRow.getAttribute("aria-rowindex"))).toBeLessThan(beforeRowIndex);
      await expect.poll(() => topRowPosition(tree)).toMatchObject({ id: before?.id });
      const after = await topRowPosition(tree);
      expect(after?.offset).toBeCloseTo(before?.offset ?? 0, 0);
      expect(new URL(page.url()).searchParams.get("scope")).toBe("deep-0");
      expect(new URL(page.url()).searchParams.get("activity")).toBe("running");
      expect(new URL(page.url()).searchParams.get("sel")).toBe("call");
      expect(new URL(page.url()).searchParams.get("owner")).toBe("reorder-child-0");
      expect(new URL(page.url()).searchParams.get("call")).toBe("id:reorder-call-10");
      await expect(slider).toHaveAttribute("aria-valuenow", zoomBefore ?? "");
      await tree.evaluate(
        (element, height) => {
          element.scrollTop = height * 39;
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
        },
        viewport.width < 768 ? 176 : 30,
      );
      await expect(page.getByTestId("tree-row-reorder-child-0")).toBeVisible();
      await page
        .getByTestId("tree-row-reorder-child-0")
        .getByRole("link", { name: /Show details:/ })
        .click();
      const restoredDrawer = page.getByRole("dialog");
      await restoredDrawer.getByRole("tab", { name: "Workflow" }).click();
      if ((await restoredDrawer.getByTestId("workflow-calls").getAttribute("open")) === null) {
        await restoredDrawer.getByTestId("workflow-calls").locator("summary").click();
      }
      await expect(
        restoredDrawer
          .getByTestId(`call-cost-reorder-child-0-${stableIndex}`)
          .getByRole("button", { name: /Collapse LLM call/ }),
      ).toBeVisible();
    } finally {
      await stream.close();
    }
  });
}

test("follows only newly observed eligible activity and pauses on manual scrolling", async ({ page }) => {
  const stream = await workflowStream();
  let initialMtime: number | null = null;
  let sourceRevision = 0;
  let followVersion = 0;
  let outsideVersion = 0;
  let snapshotReads = 0;
  try {
    await installDeepWorkflow(page, 20, 1, false, (session) => {
      initialMtime ??= session.mtime;
      snapshotReads += 1;
      const pending = [session.root];
      let latestOwner: typeof session.root | undefined;
      let outsideOwner: typeof session.root | undefined;
      while (pending.length > 0) {
        const node = pending.pop();
        if (node === undefined) continue;
        if (node.node_id === "deep-20") latestOwner = node;
        if (node.node_id === "sibling-0") outsideOwner = node;
        pending.push(...node.children);
      }
      if (latestOwner !== undefined) {
        latestOwner.llm_calls = Array.from({ length: followVersion }, (_, index) =>
          makeCall({
            call_id: `live-deep-${index + 1}`,
            source_stream_id: "live-deep-stream",
            source_order: index + 1,
            start: metric(2_000 + index),
          }),
        );
        if (sourceRevision === 3 && latestOwner.llm_calls[0] !== undefined) {
          latestOwner.llm_calls[0].tokens.input.value = 4_321;
        }
      }
      if (outsideOwner !== undefined && outsideVersion > 0) {
        outsideOwner.llm_calls = [
          makeCall({
            call_id: "live-outside",
            source_stream_id: "outside-stream",
            source_order: 1,
            start: metric(3_000),
          }),
        ];
      }
      session.mtime = (initialMtime ?? 0) + sourceRevision;
    });
    await page.route("**/api/sessions/events", (route) => route.continue({ url: stream.url }));
    await page.goto(`/sessions/${encodeURIComponent(WORKFLOW_SESSION)}?scope=deep-0&activity=running`);
    await assertNoSelectionActionControls(page);
    const tree = page.getByTestId("tree-scroll");
    const follow = page.getByRole("button", { name: "Follow latest" });
    await expect(follow).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Follow latest" }).click();
    await expect(page.getByRole("button", { name: "Following latest" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("status").filter({ hasText: "No new activity in this view" })).toBeVisible();
    await assertNoSelectionActionControls(page);
    await waitForStreamConnection(stream.connected, test.info().timeout);

    followVersion = 1;
    sourceRevision = 1;
    const firstMtime = (initialMtime ?? 0) + sourceRevision;
    const firstRefresh = waitForSessionRefresh(page);
    stream.emit(makeSummary({ id: WORKFLOW_SESSION, mtime: firstMtime }));
    await firstRefresh;
    await expect(page.getByTestId("tree-row-deep-20")).toBeVisible();
    await assertNoSelectionActionControls(page);
    const firstFollowScroll = await tree.evaluate((element) => element.scrollTop);
    const firstFollowPosition = await topRowPosition(tree);
    const readsAfterNewActivity = snapshotReads;
    sourceRevision = 2;
    const sameObservationRefresh = waitForSessionRefresh(page);
    stream.emit(makeSummary({ id: WORKFLOW_SESSION, mtime: (initialMtime ?? 0) + sourceRevision }));
    await sameObservationRefresh;
    await expect.poll(() => snapshotReads).toBeGreaterThan(readsAfterNewActivity);
    await assertNoSelectionActionControls(page);
    await expect(tree).toHaveJSProperty("scrollTop", firstFollowScroll);
    expect(new URL(page.url()).searchParams.get("activity")).toBe("running");

    sourceRevision = 3;
    const metricOnlyRefresh = waitForSessionRefresh(page);
    stream.emit(makeSummary({ id: WORKFLOW_SESSION, mtime: (initialMtime ?? 0) + sourceRevision }));
    await metricOnlyRefresh;
    await expect.poll(() => snapshotReads).toBeGreaterThan(readsAfterNewActivity + 1);
    await assertNoSelectionActionControls(page);
    await expect(tree).toHaveJSProperty("scrollTop", firstFollowScroll);
    expect(new URL(page.url()).searchParams.get("activity")).toBe("running");

    outsideVersion = 1;
    sourceRevision = 4;
    const outsideRefresh = waitForSessionRefresh(page);
    stream.emit(makeSummary({ id: WORKFLOW_SESSION, mtime: (initialMtime ?? 0) + sourceRevision }));
    await outsideRefresh;
    await expect.poll(() => snapshotReads).toBeGreaterThan(readsAfterNewActivity + 2);
    await assertNoSelectionActionControls(page);
    await expect.poll(() => topRowPosition(tree)).toEqual(firstFollowPosition);
    expect(new URL(page.url()).searchParams.get("scope")).toBe("deep-0");

    const box = await tree.boundingBox();
    if (box === null) throw new Error("The workflow tree has no viewport");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 180);
    await expect(page.getByRole("button", { name: "Follow latest" })).toHaveAttribute("aria-pressed", "false");
    await assertNoSelectionActionControls(page);
    const manualScrollTop = await tree.evaluate((element) => element.scrollTop);
    followVersion = 2;
    sourceRevision = 5;
    const pausedRefresh = waitForSessionRefresh(page);
    stream.emit(makeSummary({ id: WORKFLOW_SESSION, mtime: (initialMtime ?? 0) + sourceRevision }));
    await pausedRefresh;
    await expect.poll(() => snapshotReads).toBeGreaterThan(readsAfterNewActivity + 3);
    await assertNoSelectionActionControls(page);
    await expect(tree).toHaveJSProperty("scrollTop", manualScrollTop);
    expect(new URL(page.url()).searchParams.get("scope")).toBe("deep-0");
  } finally {
    await stream.close();
  }
});

test("Escape clears a selected node and pauses follow from a non-input control", async ({ page }) => {
  await installDeepWorkflow(page, 0);
  await page.goto(`${sessionUrl}?sel=node&entity=deep-0`);
  const follow = page.getByRole("button", { name: "Follow latest" });
  await follow.click();
  await expect(page.getByRole("button", { name: "Following latest" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("follow-latest-toggle")).toHaveAttribute("aria-pressed", "false");
  expect(new URL(page.url()).searchParams.has("sel")).toBe(false);
});

test("restores the same native row across the fixed-row breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installDeepWorkflow(page, 0, 70);
  await page.goto(`/sessions/${encodeURIComponent(WORKFLOW_SESSION)}`);
  const tree = page.getByTestId("tree-scroll");
  await expect(page.getByTestId("tree-row-session")).toBeVisible();
  await tree.evaluate((element) => {
    element.scrollTop = 600;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const before = await topRowPosition(tree);
  expect(before).not.toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("tree-row-session")).toBeVisible();
  await expect
    .poll(() => topRowPosition(tree))
    .toMatchObject({
      id: before?.id,
      offset: Math.min(before?.offset ?? 0, 175),
    });
});

test("restores the saved workflow anchor and agent panel scroll after POP", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installDeepWorkflow(page, 30, 0);
  await page.goto(`/sessions/${encodeURIComponent(WORKFLOW_SESSION)}?scope=deep-0`);
  const tree = page.getByTestId("tree-scroll");
  for (let index = 0; index < 12; index += 1) {
    const toggle = page.getByTestId(`toggle-deep-${index}`);
    if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-label")) === "Expand") {
      await toggle.click();
    }
  }
  await tree.evaluate((element) => {
    element.scrollTop = 180;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const savedTreePosition = await topRowPosition(tree);
  const agents = page.locator("#agent-summary-panel");
  await agents.evaluate((element) => {
    element.scrollTop = 120;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Whole session" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has("scope")).toBe(false);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-0");
  await expect.poll(() => topRowPosition(tree)).toEqual(savedTreePosition);
  await expect(agents).toHaveJSProperty("scrollTop", 120);
});

test("restores a hidden phone Workflow anchor after POP without blocking the Agents panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installDeepWorkflow(page, 30, 0);
  await page.goto(`/sessions/${encodeURIComponent(WORKFLOW_SESSION)}?scope=deep-0`);
  const tree = page.getByTestId("tree-scroll");
  for (let index = 0; index < 10; index += 1) {
    const toggle = page.getByTestId(`toggle-deep-${index}`);
    if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-label")) === "Expand") await toggle.click();
  }
  await tree.evaluate((element) => {
    element.scrollTop = 500;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const savedTreePosition = await topRowPosition(tree);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const agents = page.locator("#agent-summary-panel");
  await agents.evaluate((element) => {
    element.scrollTop = 100;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Whole session" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has("scope")).toBe(false);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe("deep-0");
  await expect(page.getByTestId("session-workspace")).toHaveAttribute("data-mobile-panel", "agents");
  await expect(agents).toHaveJSProperty("scrollTop", 100);
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await expect.poll(() => topRowPosition(tree)).toEqual(savedTreePosition);
});

test("queues a follow reveal while the phone Agents panel is open", async ({ page }) => {
  const stream = await workflowStream();
  let initialMtime: number | null = null;
  let sourceRevision = 0;
  let append = false;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await installDeepWorkflow(page, 20, 1, false, (session) => {
      initialMtime ??= session.mtime;
      if (append) {
        const pending = [session.root];
        while (pending.length > 0) {
          const node = pending.pop();
          if (node === undefined) continue;
          if (node.node_id === "deep-20") {
            node.llm_calls = [
              makeCall({ call_id: "queued-live", source_stream_id: "queued", source_order: 1, start: metric(4_000) }),
            ];
          }
          pending.push(...node.children);
        }
      } else {
        const pending = [session.root];
        while (pending.length > 0) {
          const node = pending.pop();
          if (node === undefined) continue;
          if (node.node_id === "deep-20") node.llm_calls = [];
          pending.push(...node.children);
        }
      }
      session.mtime = (initialMtime ?? 0) + sourceRevision;
    });
    await page.route("**/api/sessions/events", (route) => route.continue({ url: stream.url }));
    await page.goto(`/sessions/${encodeURIComponent(WORKFLOW_SESSION)}?scope=deep-0`);
    await waitForStreamConnection(stream.connected, test.info().timeout);
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: "Follow latest" }).click();
    append = true;
    sourceRevision = 1;
    const appendedRefresh = waitForSessionRefresh(page);
    stream.emit(makeSummary({ id: WORKFLOW_SESSION, mtime: (initialMtime ?? 0) + sourceRevision }));
    await appendedRefresh;
    await expect(page.getByTestId("session-workspace")).toHaveAttribute("data-mobile-panel", "agents");
    await page.getByRole("button", { name: "Workflow", exact: true }).click();
    await expect(page.getByTestId("tree-row-deep-20")).toBeVisible();
    await expect(page.getByTestId("session-workspace")).toHaveAttribute("data-mobile-panel", "workflow");
  } finally {
    await stream.close();
  }
});

test("pauses follow before manual Agents sorting controls run", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installDeepWorkflow(page, 4, 0);
  await page.goto(`/sessions/${encodeURIComponent(WORKFLOW_SESSION)}`);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const follow = page.getByTestId("follow-latest-toggle");
  await follow.click();
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  const metricsToggle = page.locator('[data-testid^="agent-summary-card-"] summary[aria-label$="metrics"]').first();
  await metricsToggle.click();
  await expect(follow).toHaveAttribute("aria-pressed", "false");
  await follow.click();
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Sort agents").selectOption("duration");
  await expect(follow).toHaveAttribute("aria-pressed", "false");
});

test("keeps the open Calls drawer reading position and marked expanded call across a live prepend", async ({
  page,
}) => {
  const stream = await workflowStream();
  let initialMtime: number | null = null;
  let sourceRevision = 0;
  let prepend = false;
  let stableIndex = 0;
  try {
    await installDeepWorkflow(page, 4, 0, false, (session) => {
      initialMtime ??= session.mtime;
      const turn = session.root.children.find((node) => node.node_id === "u1");
      if (turn !== undefined) {
        const start = (turn.llm_calls.at(-1)?.start.value ?? 0) + 10_000;
        if (turn.llm_calls.length < 42) {
          stableIndex = turn.llm_calls.length + 10;
          turn.llm_calls.push(
            ...Array.from({ length: 40 }, (_, index) =>
              makeCall({
                call_id: `table-call-${index}`,
                start: metric(start + index * 1_000),
                source_stream_id: "table-stream",
                source_order: index,
              }),
            ),
          );
        }
      }
      if (prepend) {
        session.root.children.unshift(
          makeNode({ node_id: "drawer-live-first", kind: "turn", topic: "Live first row" }),
        );
      }
      session.mtime = (initialMtime ?? 0) + sourceRevision;
    });
    await installWorkflowDetail(page, "u1");
    await page.route("**/api/sessions/events", (route) => route.continue({ url: stream.url }));
    await page.goto(sessionUrl);
    await page.getByLabel("Scope target").selectOption("session");
    await page.getByRole("button", { name: "Focus subtree" }).click();
    await page.getByLabel("Activity filter").selectOption("running");
    await page.getByRole("button", { name: "Expand matching paths" }).click();
    await expect(page.getByTestId("tree-row-deep-0")).toBeVisible();
    const startSlider = page.getByRole("slider").first();
    await startSlider.focus();
    for (let index = 0; index < 12; index += 1) await page.keyboard.press("ArrowRight");
    const zoomBefore = await startSlider.getAttribute("aria-valuenow");
    await page
      .getByTestId("tree-row-u1")
      .getByRole("link", { name: /Show details:/ })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "Workflow" }).click();
    const callsDisclosure = dialog.getByTestId("workflow-calls");
    if ((await callsDisclosure.getAttribute("open")) === null) await callsDisclosure.locator("summary").click();
    await expect(dialog.getByRole("tab", { name: "Workflow" })).toHaveAttribute("aria-selected", "true");
    const callsPanel = dialog.getByRole("tabpanel", { name: "Workflow" });
    const callsTable = dialog.getByTestId("workflow-calls");
    const selectedCall = callsTable.getByTestId(`call-cost-u1-${stableIndex}`);
    await selectedCall.click();
    await expect(selectedCall).toHaveAttribute("data-selection", "exact");
    const selectedExpand = selectedCall.getByRole("button", { name: /Expand LLM call/ });
    if (await selectedExpand.count()) await selectedExpand.click();
    await expect(selectedCall.getByRole("button", { name: /Collapse LLM call/ })).toBeVisible();
    const measuredCall = callsTable.getByTestId(`call-cost-u1-${stableIndex + 1}`);
    const expand = measuredCall.getByRole("button", { name: /Expand LLM call/ });
    await expand.click();
    await expect(measuredCall.getByRole("button", { name: /Collapse LLM call/ })).toBeVisible();
    await callsPanel.evaluate(
      (element, testId) => {
        const row = element.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
        if (row === null) throw new Error(`Missing visible call row ${testId}`);
        element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top;
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
      },
      `call-cost-u1-${stableIndex + 1}`,
    );
    const before = await callsPanel.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const row = [...element.querySelectorAll<HTMLElement>("[data-testid^='call-cost-u1-']")].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.top <= bounds.top + 1 && rect.bottom > bounds.top + 1;
      });
      return row === undefined
        ? null
        : {
            id: row.dataset.testid ?? row.getAttribute("data-testid"),
            offset: bounds.top - row.getBoundingClientRect().top,
          };
    });
    expect(before).not.toBeNull();
    await waitForStreamConnection(stream.connected, test.info().timeout);
    prepend = true;
    sourceRevision = 1;
    const refresh = waitForSessionRefresh(page);
    stream.emit(makeSummary({ id: WORKFLOW_SESSION, mtime: (initialMtime ?? 0) + sourceRevision }));
    await refresh;
    await expect(dialog.getByRole("tab", { name: "Workflow" })).toHaveAttribute("aria-selected", "true");
    await expect(callsTable.getByTestId(`call-cost-u1-${stableIndex}`)).toHaveAttribute("data-selection", "exact");
    await expect(
      callsTable.getByTestId(`call-cost-u1-${stableIndex + 1}`).getByRole("button", { name: /Collapse LLM call/ }),
    ).toBeVisible();
    const after = await callsPanel.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const row = [...element.querySelectorAll<HTMLElement>("[data-testid^='call-cost-u1-']")].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.top <= bounds.top + 1 && rect.bottom > bounds.top + 1;
      });
      return row === undefined
        ? null
        : {
            id: row.dataset.testid ?? row.getAttribute("data-testid"),
            offset: bounds.top - row.getBoundingClientRect().top,
          };
    });
    expect(after).toEqual(before);
    expect(new URL(page.url()).searchParams.get("scope")).toBeNull();
    expect(new URL(page.url()).searchParams.get("activity")).toBe("running");
    expect(new URL(page.url()).searchParams.get("owner")).toBe("u1");
    expect(new URL(page.url()).searchParams.get("call")).toBe("id:table-call-10");
    await expect(startSlider).toHaveAttribute("aria-valuenow", zoomBefore ?? "");
    await expect(page.getByTestId("tree-row-deep-0")).toBeVisible();
  } finally {
    await stream.close();
  }
});
