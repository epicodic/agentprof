// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, test } from "@playwright/test";
import { installDeepWorkflow, installWorkflowDetail, WORKFLOW_SESSION } from "./helpers/workflowFixture";

const SESSION = "claude-code:11111111-1111-4111-8111-111111111111";

async function installFakeSessionEvents(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const sources: EventTarget[] = [];
    class FakeEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readonly readyState = 1;
      readonly withCredentials = false;

      constructor(readonly url: string) {
        super();
        sources.push(this);
      }

      close(): void {}
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
    Object.assign(window, {
      emitSessionEvent: (name: string, data: unknown) => {
        for (const source of sources) source.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
      },
    });
  });
}

async function emitSessionUpdate(page: import("@playwright/test").Page, mtime = 1): Promise<void> {
  await page.evaluate(
    ({ sessionId, mtime }) => {
      const emit = (window as Window & { emitSessionEvent?: (name: string, data: unknown) => void }).emitSessionEvent;
      emit?.("updated", { id: sessionId, mtime });
    },
    { sessionId: SESSION, mtime },
  );
}

test("Content loads bounded transcript metadata and fetches a body only when disclosed", async ({ page }) => {
  const requests: string[] = [];
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (url.pathname.endsWith("/transcript/entries/entry-1")) {
      await route.fulfill({
        json: {
          entry_id: "entry-1",
          owner_id: "u1",
          source_stream_id: "stream-u1",
          source_position: 1,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: 1000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: "final",
          ownership_evidence: "recorded",
          preview: "Recorded reply",
          block_availability: ["recorded"],
          blocks: [
            {
              kind: "text",
              native_type: null,
              text: "# Recorded full reply\n\n**saved formatting**\n\n- first\n- second\n\n```ts\nconst n = 1;\n```\n\n| A | B |\n| - | - |\n| x | y |\n\n[useful link](https://example.com)",
              data: null,
              availability: "recorded",
            },
          ],
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          logical_stream_id: "stream-u1",
          source_request_id: null,
          invocation_id: null,
          event_id: null,
          subject_node_id: null,
          references: [],
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: [
          {
            entry_id: "entry-1",
            owner_id: "u1",
            source_stream_id: "stream-u1",
            source_position: 1,
            block_position: 0,
            native_id: null,
            native_ordinal: null,
            timestamp: { value: 1000, provenance: "exact" },
            kind: "assistant_message",
            role: "assistant",
            channel: "final",
            ownership_evidence: "recorded",
            preview: "Recorded reply",
            block_availability: ["recorded"],
          },
        ],
        next_cursor: null,
        previous_cursor: null,
        anchor_index: null,
      },
    });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  await expect(page.getByText("Recorded reply", { exact: true })).toBeVisible();
  expect(requests.some((request) => request.includes("/transcript/entries/entry-1"))).toBe(false);
  const entry = page.getByTestId("transcript-entry-entry-1");
  await expect(entry.getByRole("link")).toHaveCount(0);
  await expect(entry.getByRole("button", { name: "Expand transcript entry entry-1" })).toHaveCount(1);
  await expect(entry.locator('[class*="meta"]').getByText(/^Agent \d+$/)).toBeVisible();
  await expect(entry.getByText("assistant", { exact: true })).toHaveCount(0);
  await expect(entry.getByRole("button", { name: "Mark transcript entry entry-1" })).toHaveCount(0);
  await entry.focus();
  await entry.press("Enter");
  await expect(entry).toHaveAttribute("data-selection", "exact");
  expect(requests.some((request) => request.includes("/transcript/entries/entry-1"))).toBe(false);
  await page.getByRole("button", { name: "Expand transcript entry entry-1" }).click();
  await expect(page.getByRole("heading", { name: "Recorded full reply", level: 1 })).toBeVisible();
  await expect(entry.locator("strong")).toHaveText("saved formatting");
  await expect(entry.locator("ul li")).toHaveText(["first", "second"]);
  await expect(entry.locator("pre code")).toContainText("const n = 1;");
  const codeStyle = await entry.locator("pre").evaluate((element) => {
    const style = getComputedStyle(element);
    return { fontFamily: style.fontFamily, whiteSpace: style.whiteSpace };
  });
  expect(codeStyle.fontFamily).toMatch(/monospace/);
  expect(codeStyle.whiteSpace).toBe("pre");
  await expect(entry.locator("table")).toBeVisible();
  await expect(entry.getByRole("link", { name: "useful link" })).toHaveAttribute("href", "https://example.com");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  expect(requests.some((request) => request.includes("/transcript/entries/entry-1"))).toBe(true);
});

test("server search opens an unloaded entry context and Back restores search state", async ({ page }) => {
  const sessionPath = `/api/sessions/${encodeURIComponent(SESSION)}`;
  await page.route(`**${sessionPath}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await page.route(`**${sessionPath}/nodes/u1`, async (route) => {
    await route.fulfill({
      json: {
        node_id: "u1",
        prompt: Array.from({ length: 36 }, (_, index) => `Legacy prompt context ${index + 1}`).join("\n"),
        result: "",
        arguments: {},
      },
    });
  });
  await page.route(`**${sessionPath}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/transcript/search")) {
      await route.fulfill({
        json: {
          session_id: SESSION,
          scope_id: "u1",
          mtime: 1000,
          revision: "r2",
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          hits: [
            {
              entry_id: "late-entry",
              owner_id: "u1",
              kind: "assistant_message",
              role: "assistant",
              channel: "final",
              timestamp: { value: 2000, provenance: "exact" },
              block_position: 0,
              snippet: "The rare needle appears here",
            },
            {
              entry_id: "ambiguous-root-entry",
              owner_id: "u1",
              kind: "user_message",
              role: "user",
              ownership_evidence: "root_fallback",
              channel: null,
              timestamp: { value: 1000, provenance: "exact" },
              block_position: 0,
              snippet: "Ambiguous root prompt",
            },
          ],
          next_cursor: null,
          previous_cursor: null,
        },
      });
      return;
    }
    if (url.pathname.endsWith("/transcript/entries/late-entry")) {
      await route.fulfill({
        json: {
          entry_id: "late-entry",
          owner_id: "u1",
          source_stream_id: "stream-u1",
          source_position: 2,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: 2000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: "final",
          ownership_evidence: "recorded",
          preview: "The rare needle appears here",
          block_availability: ["recorded"],
          blocks: [
            {
              kind: "text",
              native_type: null,
              text: "The rare needle appears here in the complete body",
              data: null,
              availability: "recorded",
            },
          ],
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          logical_stream_id: "stream-u1",
          source_request_id: null,
          invocation_id: null,
          event_id: null,
          subject_node_id: null,
          references: [],
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "r2",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: url.searchParams.has("anchor")
          ? Array.from({ length: 51 }, (_, index) => {
              const entryId = index === 25 ? "late-entry" : `neighbor-${index}`;
              return {
                entry_id: entryId,
                owner_id: "u1",
                source_stream_id: "stream-u1",
                source_position: index + 1,
                block_position: 0,
                native_id: null,
                native_ordinal: null,
                timestamp: { value: index * 1000, provenance: "exact" },
                kind: "assistant_message",
                role: "assistant",
                channel: "final",
                ownership_evidence: "recorded",
                preview: entryId === "late-entry" ? "The rare needle appears here" : `Context neighbor ${index}`,
                block_availability: ["recorded"],
              };
            })
          : [],
        next_cursor: null,
        previous_cursor: null,
        anchor_index: url.searchParams.has("anchor") ? 25 : null,
      },
    });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  const input = page.getByRole("searchbox", { name: "Search recorded content" });
  await input.fill("rare needle");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("The rare needle appears here", { exact: true })).toBeVisible();
  const ambiguousRootHit = page.getByTestId("transcript-entry-ambiguous-root-entry");
  await expect(ambiguousRootHit.locator('[class*="meta"]')).toContainText("Incoming message → Agent 1");
  await expect(ambiguousRootHit.locator('[class*="meta"]')).not.toContainText("User → Agent 1");
  await page.getByRole("button", { name: "Expand transcript entry late-entry" }).click();
  await expect(page.getByText("The rare needle appears here in the complete body", { exact: true })).toBeVisible();
  const contentPanel = page
    .locator('[role="tabpanel"]:visible')
    .filter({ has: page.getByTestId("transcript-section") });
  const openEntry = page.getByRole("link", { name: "Show details: Surrounding context for late-entry" });
  await openEntry.scrollIntoViewIfNeeded();
  await expect(openEntry).toHaveAttribute("href", /sel=transcript.*entry=late-entry/);
  await openEntry.evaluate((link) => {
    link.addEventListener(
      "click",
      (event) => {
        const mouseEvent = event as MouseEvent;
        queueMicrotask(() => {
          document.documentElement.dataset.contextClickCtrl = String(mouseEvent.ctrlKey);
          document.documentElement.dataset.contextClickPrevented = String(event.defaultPrevented);
        });
      },
      { once: true },
    );
  });
  const originalSearchUrl = page.url();
  await openEntry.click({ modifiers: ["Control"] });
  const modifiedClick = await page.locator("html").evaluate((element) => ({
    ctrlKey: element.getAttribute("data-context-click-ctrl"),
    defaultPrevented: element.getAttribute("data-context-click-prevented"),
  }));
  expect(modifiedClick).toEqual({ ctrlKey: "true", defaultPrevented: "false" });
  expect(page.url()).toBe(originalSearchUrl);
  const savedSearchScroll = await contentPanel.evaluate((panel) => panel.scrollTop);
  await openEntry.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("entry")).toBe("late-entry");
  await expect(page.getByText("The rare needle appears here in the complete body", { exact: true })).toBeVisible();
  await expect(page.getByTestId("transcript-entry-neighbor-0")).toBeVisible();
  const explicitEntry = page.getByTestId("transcript-entry-late-entry");
  await expect(explicitEntry).toBeInViewport();
  const targetBounds = await explicitEntry.boundingBox();
  const panelBounds = await contentPanel.boundingBox();
  if (targetBounds === null || panelBounds === null) throw new Error("Transcript target or Content panel is detached.");
  expect(targetBounds.y).toBeGreaterThanOrEqual(panelBounds.y);
  expect(targetBounds.y + targetBounds.height).toBeLessThanOrEqual(panelBounds.y + panelBounds.height);
  await page.goBack();
  await expect(page.getByRole("searchbox", { name: "Search recorded content" })).toHaveValue("rare needle");
  await expect(page.getByText("The rare needle appears here", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse transcript entry late-entry" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect.poll(() => contentPanel.evaluate((panel) => panel.scrollTop)).toBe(savedSearchScroll);
});

test("expanded entries show readable structured data and retain identical blocks", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/transcript/entries/entry-1")) {
      await route.fulfill({
        json: {
          entry_id: "entry-1",
          owner_id: "u1",
          source_stream_id: "stream-u1",
          source_position: 1,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: 1000, provenance: "exact" },
          kind: "tool_result",
          role: "assistant",
          channel: null,
          ownership_evidence: "recorded",
          preview: "First response block",
          block_availability: ["recorded", "unsupported"],
          blocks: [
            { kind: "text", native_type: null, text: "**literal tool output**", data: null, availability: "recorded" },
            {
              kind: "structured",
              native_type: "arguments",
              text: null,
              data: { value: "visible metadata" },
              availability: "unsupported",
            },
            { kind: "text", native_type: null, text: "**literal tool output**", data: null, availability: "recorded" },
          ],
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          logical_stream_id: "stream-u1",
          source_request_id: null,
          invocation_id: null,
          event_id: null,
          subject_node_id: null,
          references: [],
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: [
          {
            entry_id: "entry-1",
            owner_id: "u1",
            source_stream_id: "stream-u1",
            source_position: 1,
            block_position: 0,
            native_id: null,
            native_ordinal: null,
            timestamp: { value: 1000, provenance: "exact" },
            kind: "tool_result",
            role: "assistant",
            channel: null,
            ownership_evidence: "recorded",
            preview: "First response block",
            block_availability: ["recorded", "unsupported"],
          },
        ],
        next_cursor: null,
        previous_cursor: null,
        anchor_index: null,
      },
    });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  await page.getByRole("button", { name: "Expand transcript entry entry-1" }).click();
  const body = page.getByTestId("transcript-body-entry-1");
  await expect(body.locator("pre").filter({ hasText: "**literal tool output**" })).toHaveCount(2);
  await expect(body.locator("strong")).toHaveCount(0);
  await expect(body.getByText(/visible metadata/)).toBeVisible();
});

test("an explicit entry anchor never substitutes an entry owned by another node", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: [
          {
            entry_id: "neighbor-entry",
            owner_id: "u2",
            source_stream_id: "stream-u2",
            source_position: 1,
            block_position: 0,
            native_id: null,
            native_ordinal: null,
            timestamp: { value: 1000, provenance: "exact" },
            kind: "assistant_message",
            role: "assistant",
            channel: null,
            ownership_evidence: "recorded",
            preview: "Neighbor content",
            block_availability: ["recorded"],
          },
        ],
        next_cursor: null,
        previous_cursor: null,
        anchor_index: 2,
      },
    });
  });

  await page.goto(
    `/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content&sel=transcript&owner=u1&entry=missing-entry`,
  );
  await expect(page.getByText("This entry is no longer available in the transcript.")).toBeVisible();
  await expect(page.getByTestId("transcript-entry-neighbor-entry")).toHaveCount(0);
});

test("an explicit anchor retains its surrounding entries and expands only the target body", async ({ page }) => {
  const bodyRequests: string[] = [];
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/transcript/entries/")) {
      const entryId = url.pathname.split("/").at(-1) ?? "";
      bodyRequests.push(entryId);
      await route.fulfill({
        json: {
          entry_id: entryId,
          owner_id: "u1",
          source_stream_id: "stream-u1",
          source_position: 2,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: 2000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: null,
          ownership_evidence: "recorded",
          preview: "Target preview",
          block_availability: ["recorded"],
          blocks: [{ kind: "text", native_type: null, text: "Target full body", data: null, availability: "recorded" }],
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          logical_stream_id: "stream-u1",
          source_request_id: null,
          invocation_id: null,
          event_id: null,
          subject_node_id: null,
          references: [],
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: ["before-entry", "target-entry", "after-entry"].map((entryId, index) => ({
          entry_id: entryId,
          owner_id: "u1",
          source_stream_id: "stream-u1",
          source_position: index + 1,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: (index + 1) * 1000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: null,
          ownership_evidence: "recorded",
          preview: `${entryId} preview`,
          block_availability: ["recorded"],
        })),
        next_cursor: null,
        previous_cursor: null,
        anchor_index: 1,
      },
    });
  });

  await page.goto(
    `/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content&sel=transcript&owner=u1&entry=target-entry`,
  );
  await expect(page.getByTestId("transcript-entry-before-entry")).toBeVisible();
  await expect(page.getByTestId("transcript-entry-target-entry")).toBeVisible();
  await expect(page.getByTestId("transcript-entry-after-entry")).toBeVisible();
  await expect(page.getByText("Target full body")).toBeVisible();
  expect(bodyRequests).toEqual(["target-entry"]);
});

test("a call caption keeps the exact call selection and filters its transcript", async ({ page }) => {
  const filters: URLSearchParams[] = [];
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    filters.push(url.searchParams);
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: url.searchParams.get("node_id"),
        mtime: 1000,
        revision: "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: [
          {
            entry_id: "call-entry",
            owner_id: "u1",
            source_stream_id: "stream-u1",
            source_position: 1,
            block_position: 0,
            native_id: null,
            native_ordinal: null,
            timestamp: { value: 1000, provenance: "exact" },
            kind: "assistant_message",
            role: "assistant",
            channel: "analysis",
            ownership_evidence: "recorded",
            preview: "Call body",
            block_availability: ["recorded"],
          },
        ],
        next_cursor: null,
        previous_cursor: null,
        anchor_index: null,
      },
    });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow&sel=call&owner=u1&call=id%3Amsg_3`);
  const caption = page.getByRole("link", { name: "Show details: Recorded content" });
  await expect(caption).toBeVisible();
  await expect(caption).toHaveAttribute("href", /node=u1&tab=content&sel=call&owner=u1&call=id%3Amsg_3/);
  await caption.click();
  await expect(page.getByTestId("transcript-entry-call-entry")).toBeVisible();
  expect(filters.some((params) => params.get("call_key") === "id:msg_3" && params.get("node_id") === "u1")).toBe(true);
  expect(new URL(page.url()).searchParams.get("call")).toBe("id:msg_3");

  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await dialog.getByRole("link", { name: /LLM call 4/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("call")).toBe("id:msg_4");
  await dialog.getByRole("tab", { name: "Content", exact: true }).click();
  await expect.poll(() => filters.some((params) => params.get("call_key") === "id:msg_4")).toBe(true);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("call")).toBe("id:msg_3");
  await expect.poll(() => filters.some((params) => params.get("call_key") === "id:msg_3")).toBe(true);
});

test("a native nested transcript anchor reloads with its body on desktop and phone widths", async ({ page }) => {
  const ownerId = "toolu_agent2";
  const transcriptPath = `/api/sessions/${encodeURIComponent(SESSION)}/transcript`;
  const metadataResponse = await page.request.get(`${transcriptPath}?node_id=${ownerId}`);
  expect(metadataResponse.ok()).toBe(true);
  const metadata = await metadataResponse.json();
  const target = metadata.entries.find(
    (entry: { preview: string | null; block_availability: string[] }) =>
      entry.preview !== null && entry.block_availability.includes("recorded"),
  );
  expect(target).toBeDefined();
  const detailResponse = await page.request.get(`${transcriptPath}/entries/${encodeURIComponent(target.entry_id)}`);
  expect(detailResponse.ok()).toBe(true);
  const detail = await detailResponse.json();
  const recordedText = detail.blocks.find((block: { text: string | null }) => block.text !== null)?.text;
  expect(recordedText).toBeTruthy();

  const url =
    `/sessions/${encodeURIComponent(SESSION)}?node=${ownerId}&tab=content&sel=transcript` +
    `&owner=${ownerId}&entry=${encodeURIComponent(target.entry_id)}`;
  const entry = page.getByTestId(`transcript-entry-${target.entry_id}`);
  const body = page.getByTestId(`transcript-body-${target.entry_id}`);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(url);
    await expect(entry).toHaveAttribute("data-selection", "exact");
    await expect(entry).toBeInViewport();
    await expect(body).toContainText(recordedText);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.reload();
    await expect(entry).toHaveAttribute("data-selection", "exact");
    await expect(body).toContainText(recordedText);
    await expect(entry.locator('[class*="heading"]').getByRole("link")).toHaveCount(0);
    await expect(entry.getByRole("button", { name: /Collapse transcript entry/ })).toHaveCount(1);
  }
});

test("a deep nested workflow keeps a 2,000-entry transcript window bounded and finds unloaded content", async ({
  page,
}) => {
  await installDeepWorkflow(page, 20);
  await installWorkflowDetail(page, "deep-0");
  await installWorkflowDetail(page, "deep-20");
  const sessionPath = `/api/sessions/${encodeURIComponent(WORKFLOW_SESSION)}`;
  const rows = Array.from({ length: 2000 }, (_, index) => ({
    entry_id: `large-entry-${index}`,
    owner_id: "deep-0",
    source_stream_id: "large-main",
    source_position: index,
    block_position: 0,
    native_id: null,
    native_ordinal: null,
    timestamp: { value: index, provenance: "exact" },
    kind: "assistant_message",
    role: "assistant",
    channel: null,
    ownership_evidence: "recorded",
    preview: `Transcript row ${index}`,
    block_availability: ["recorded"],
  }));
  const grandchild = {
    entry_id: "grandchild-entry",
    owner_id: "deep-20",
    source_stream_id: "large-grandchild",
    source_position: 0,
    block_position: 0,
    native_id: null,
    native_ordinal: null,
    timestamp: { value: 2001, provenance: "exact" },
    kind: "user_message",
    role: "user",
    sender: "deep-19",
    channel: "final",
    ownership_evidence: "recorded",
    preview: "Grandchild response preview",
    block_availability: ["recorded"],
  };
  const bodyRequests: string[] = [];
  await page.route(`**${sessionPath}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/transcript/search")) {
      const query = url.searchParams.get("q") ?? "";
      const wholeSession = !url.searchParams.has("node_id");
      const hit =
        query === "grandchild needle" && wholeSession
          ? { ...grandchild, snippet: "The grandchild needle appears here", block_position: 0 }
          : query === "rare phrase [.*] café" && !wholeSession
            ? { ...rows[1999], snippet: "Rare phrase [.*] café in the final response", block_position: 0 }
            : null;
      await route.fulfill({
        json: {
          session_id: WORKFLOW_SESSION,
          scope_id: wholeSession ? null : "deep-0",
          mtime: 1000,
          revision: "large-r1",
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          hits: hit === null ? [] : [hit],
          next_cursor: null,
          previous_cursor: null,
        },
      });
      return;
    }
    if (url.pathname.includes("/transcript/entries/")) {
      const entryId = url.pathname.split("/").at(-1) ?? "";
      bodyRequests.push(entryId);
      const text =
        entryId === "grandchild-entry"
          ? "The grandchild needle appears here in full"
          : "Rare phrase [.*] café in the complete final response";
      const sourceEntry = entryId === "grandchild-entry" ? grandchild : rows[1999];
      await route.fulfill({
        json: {
          ...sourceEntry,
          entry_id: entryId,
          blocks: [{ kind: "text", native_type: null, text, data: null, availability: "recorded" }],
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          logical_stream_id: sourceEntry.source_stream_id,
          source_request_id: null,
          invocation_id: null,
          event_id: null,
          subject_node_id: null,
          references: [],
        },
      });
      return;
    }
    const anchor = url.searchParams.get("anchor");
    const after = url.searchParams.get("after");
    const entries =
      anchor === "grandchild-entry"
        ? [grandchild]
        : anchor === "large-entry-1999"
          ? rows.slice(1998)
          : after !== null
            ? rows.slice(50, 100)
            : rows.slice(0, 50);
    await route.fulfill({
      json: {
        session_id: WORKFLOW_SESSION,
        scope_id: url.searchParams.get("node_id"),
        mtime: 1000,
        revision: "large-r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries,
        next_cursor: after === null && anchor === null ? "cursor-50" : null,
        previous_cursor: after !== null ? "cursor-0" : null,
        anchor_index: anchor === null ? null : anchor === "large-entry-1999" ? 1 : 0,
      },
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/sessions/${encodeURIComponent(WORKFLOW_SESSION)}?node=deep-0&tab=content`);
  const section = page.getByTestId("transcript-section");
  await expect(section.getByTestId("transcript-entry-large-entry-0")).toBeVisible();
  await expect(section.locator("[data-entry-id]")).toHaveCount(50);
  expect(bodyRequests).toEqual([]);
  await section.getByRole("button", { name: "Next" }).click();
  await expect(section.getByTestId("transcript-entry-large-entry-50")).toBeVisible();
  await expect(section.locator("[data-entry-id]")).toHaveCount(50);
  await expect(section.getByRole("button", { name: "Previous" })).toBeEnabled();

  await section.getByRole("searchbox", { name: "Search recorded content" }).fill("rare phrase [.*] café");
  await section.getByRole("button", { name: "Search", exact: true }).click();
  await expect(section.getByText("Rare phrase [.*] café in the final response", { exact: true })).toBeVisible();
  await section.getByRole("link", { name: "Show details: Surrounding context for large-entry-1999" }).click();
  await expect(page.getByTestId("transcript-body-large-entry-1999")).toContainText(
    "Rare phrase [.*] café in the complete final response",
  );
  expect(bodyRequests).toEqual(["large-entry-1999"]);

  await page.goBack();
  await section.getByRole("searchbox", { name: "Search recorded content" }).fill("grandchild needle");
  await section.getByRole("button", { name: "Search", exact: true }).click();
  await expect(section.getByText("No matches for “grandchild needle”.", { exact: true })).toBeVisible();
  await section.getByLabel("Search scope").selectOption("whole");
  await section.getByRole("button", { name: "Search", exact: true }).click();
  await expect(section.getByText("The grandchild needle appears here", { exact: true })).toBeVisible();
  await expect(
    section
      .getByTestId("transcript-entry-grandchild-entry")
      .locator('[class*="meta"]')
      .getByText("Agent 121 → Agent 122"),
  ).toBeVisible();
  await section.getByRole("link", { name: "Show details: Surrounding context for grandchild-entry" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("owner")).toBe("deep-20");
  await expect(page.getByTestId("transcript-body-grandchild-entry")).toContainText("in full");

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("an event caption keeps the exact event selection and filters its transcript", async ({ page }) => {
  const filters: URLSearchParams[] = [];
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    filters.push(url.searchParams);
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: url.searchParams.get("node_id"),
        mtime: 1000,
        revision: "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: [
          {
            entry_id: "event-entry",
            owner_id: "u1",
            source_stream_id: "stream-u1",
            source_position: 1,
            block_position: 0,
            native_id: null,
            native_ordinal: null,
            timestamp: { value: 1000, provenance: "exact" },
            kind: "assistant_message",
            role: "assistant",
            channel: null,
            ownership_evidence: "recorded",
            preview: "Event result",
            block_availability: ["recorded"],
          },
        ],
        next_cursor: null,
        previous_cursor: null,
        anchor_index: null,
      },
    });
  });

  await page.goto(
    `/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow&sel=event&owner=u1&event=user-input%3Au1`,
  );
  await page.getByRole("button", { name: "Expand user_input" }).click();
  const caption = page.getByRole("link", { name: "Show details: Recorded content" });
  await expect(caption).toBeVisible();
  await expect(caption).toHaveAttribute("href", /node=u1&tab=content&sel=event&owner=u1&event=user-input%3Au1/);
  await caption.click();
  await expect(page.getByTestId("transcript-entry-event-entry")).toBeVisible();
  expect(filters.some((params) => params.get("event_id") === "user-input:u1" && params.get("node_id") === "u1")).toBe(
    true,
  );
  expect(new URL(page.url()).searchParams.get("event")).toBe("user-input:u1");
});

test("clearing a paginated invocation filter resets its bound cursor", async ({ page }) => {
  const requests: URL[] = [];
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const callKey = url.searchParams.get("call_key");
    const after = url.searchParams.get("after");
    const entryId = callKey === null ? "unfiltered-first" : after === null ? "filtered-first" : "filtered-second";
    const nextCursor = callKey !== null && after === null ? "filtered-cursor" : null;
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: [
          {
            entry_id: entryId,
            owner_id: "u1",
            source_stream_id: "stream-u1",
            source_position: 1,
            block_position: 0,
            native_id: null,
            native_ordinal: null,
            timestamp: { value: 1000, provenance: "exact" },
            kind: "assistant_message",
            role: "assistant",
            channel: null,
            ownership_evidence: "recorded",
            preview: `${entryId} preview`,
            block_availability: ["recorded"],
          },
        ],
        next_cursor: nextCursor,
        previous_cursor: after === null ? null : "previous-filtered",
        anchor_index: null,
      },
    });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content&sel=call&owner=u1&call=id%3Amsg_3`);
  await expect(page.getByTestId("transcript-entry-filtered-first")).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByTestId("transcript-entry-filtered-second")).toBeVisible();
  await page.getByRole("button", { name: "Clear invocation filter" }).click();
  await expect(page.getByTestId("transcript-entry-unfiltered-first")).toBeVisible();
  expect(
    requests.some(
      (request) =>
        request.searchParams.get("node_id") === "u1" &&
        request.searchParams.get("call_key") === null &&
        request.searchParams.get("event_id") === null &&
        request.searchParams.get("after") === null &&
        request.searchParams.get("anchor") === null,
    ),
  ).toBe(true);
});

test("keyboard transcript disclosure pauses Follow latest without marking or navigating", async ({ page }) => {
  const bodyRequests: string[] = [];
  const anchors: string[] = [];
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/transcript/entries/old-entry")) {
      bodyRequests.push("old-entry");
      await route.fulfill({
        json: {
          entry_id: "old-entry",
          owner_id: "u1",
          source_stream_id: "stream-u1",
          source_position: 1,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: 1000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: null,
          ownership_evidence: "recorded",
          preview: "Older target",
          block_availability: ["recorded"],
          blocks: [{ kind: "text", native_type: null, text: "Older full body", data: null, availability: "recorded" }],
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          logical_stream_id: "stream-u1",
          source_request_id: null,
          invocation_id: null,
          event_id: null,
          subject_node_id: null,
          references: [],
        },
      });
      return;
    }
    const anchor = url.searchParams.get("anchor");
    if (anchor !== null) anchors.push(anchor);
    const after = url.searchParams.get("after");
    const ids =
      after === "after-old" ? ["latest-entry"] : anchor === "old-entry" ? ["old-entry"] : ["old-entry", "latest-entry"];
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: ids.map((entryId, index) => ({
          entry_id: entryId,
          owner_id: "u1",
          source_stream_id: "stream-u1",
          source_position: entryId === "old-entry" ? 1 : 2,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: index * 1000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: null,
          ownership_evidence: "recorded",
          preview: entryId === "old-entry" ? "Older target" : "Latest entry",
          block_availability: ["recorded"],
        })),
        next_cursor: anchor === "old-entry" ? "after-old" : null,
        previous_cursor: null,
        anchor_index: anchor === null ? null : ids.indexOf(anchor),
      },
    });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  await expect(page.getByTestId("transcript-entry-old-entry")).toBeVisible();
  await page.getByTestId("transcript-section").getByRole("button", { name: "Follow latest" }).click();
  await expect(page.getByTestId("transcript-entry-latest-entry")).toBeVisible();
  await expect.poll(() => anchors).toContain("latest-entry");
  await expect(
    page.getByTestId("transcript-section").getByRole("button", { name: "Following latest" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Expand transcript entry latest-entry" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const oldEntry = page.getByTestId("transcript-entry-old-entry");
  const disclosure = page.getByRole("button", { name: "Expand transcript entry old-entry" });
  await disclosure.focus();
  await expect(disclosure).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Collapse transcript entry old-entry" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(oldEntry).toHaveAttribute("data-selection", "none");
  expect(new URL(page.url()).searchParams.get("entry")).toBeNull();
  await expect(page.getByText("Older full body")).toBeVisible();
  await expect(page.getByTestId("transcript-section").getByRole("button", { name: "Follow latest" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(bodyRequests).toEqual(["old-entry"]);
});

test("paired tool request and result captions retain their exact event identities", async ({ page }) => {
  const eventFilters: URLSearchParams[] = [];
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.has("event_id")) eventFilters.push(params);
    await route.fallback();
  });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=workflow`);
  const dialog = page.getByRole("dialog");
  const calls = dialog.getByRole("tabpanel");
  const invocation = calls.getByTestId("tool-execution-u1-subject:toolu_read1");
  await invocation.getByRole("button", { name: "Expand Read" }).click();
  const details = invocation.locator("xpath=following-sibling::tr[1]");
  const requestCaption = details.getByRole("link", { name: "Show details: Request recorded content" });
  const resultCaption = details.getByRole("link", { name: "Show details: Result recorded content" });
  await expect(requestCaption).toBeVisible();
  await expect(resultCaption).toBeVisible();
  await requestCaption.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("event")).toBe("tool-start:toolu_read1");
  await expect(page.getByTestId("transcript-section")).toBeVisible();
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("workflow");
  const restoredDetails = page
    .getByTestId("tool-execution-u1-subject:toolu_read1")
    .locator("xpath=following-sibling::tr[1]");
  await restoredDetails.getByRole("link", { name: "Show details: Result recorded content" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("event")).toBe("tool-result:toolu_read1");
  await expect(page.getByTestId("transcript-section")).toBeVisible();
  await expect
    .poll(() => eventFilters.some((params) => params.get("event_id") === "tool-start:toolu_read1"))
    .toBe(true);
  await expect
    .poll(() => eventFilters.some((params) => params.get("event_id") === "tool-result:toolu_read1"))
    .toBe(true);
  const selectedEntry = page.getByTestId("transcript-section").locator("[data-entry-id]").first();
  const entryId = await selectedEntry.getAttribute("data-entry-id");
  if (entryId === null) throw new Error("Recorded event did not resolve to an entry.");
  await expect(selectedEntry.locator('[class*="heading"]').getByRole("link")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("event")).toBe("tool-result:toolu_read1");
  expect(entryId).toBeTruthy();
});

test("following latest can be turned off from its control", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: [],
        next_cursor: null,
        previous_cursor: null,
        anchor_index: null,
      },
    });
  });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  const follow = page.getByTestId("transcript-section").getByRole("button", { name: "Follow latest" });
  await follow.click();
  const following = page.getByTestId("transcript-section").getByRole("button", { name: "Following latest" });
  await expect(following).toHaveAttribute("aria-pressed", "true");
  await following.click();
  await expect(page.getByTestId("transcript-section").getByRole("button", { name: "Follow latest" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("following latest explains why it is disabled during search", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      json: url.pathname.endsWith("/transcript/search")
        ? {
            session_id: SESSION,
            scope_id: "u1",
            mtime: 1000,
            revision: "r1",
            coverage: { source_present: true, categories: ["assistant"], reasons: [] },
            hits: [],
            next_cursor: null,
            previous_cursor: null,
          }
        : {
            session_id: SESSION,
            scope_id: "u1",
            mtime: 1000,
            revision: "r1",
            coverage: { source_present: true, categories: ["assistant"], reasons: [] },
            entries: [],
            next_cursor: null,
            previous_cursor: null,
            anchor_index: null,
          },
    });
  });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  await page.getByRole("searchbox", { name: "Search recorded content" }).fill("needle");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const follow = page.getByTestId("transcript-section").getByRole("button", { name: "Follow latest" });
  await expect(follow).toBeDisabled();
  await expect(page.getByText("Follow latest is unavailable while searching.")).toBeVisible();
});

test("a failed body refresh keeps cached content readable and exposes an explicit retry", async ({ page }) => {
  await installFakeSessionEvents(page);
  let detailRequests = 0;
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/transcript/entries/entry-1")) {
      detailRequests += 1;
      if (detailRequests > 1) {
        await route.fulfill({ status: 503, json: { detail: "temporarily unavailable" } });
        return;
      }
      await route.fulfill({
        json: {
          entry_id: "entry-1",
          owner_id: "u1",
          source_stream_id: "stream-u1",
          source_position: 1,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: 1000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: null,
          ownership_evidence: "recorded",
          preview: "Cached preview",
          block_availability: ["recorded"],
          blocks: [{ kind: "text", native_type: null, text: "Cached full body", data: null, availability: "recorded" }],
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          logical_stream_id: "stream-u1",
          source_request_id: null,
          invocation_id: null,
          event_id: null,
          subject_node_id: null,
          references: [],
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: [
          {
            entry_id: "entry-1",
            owner_id: "u1",
            source_stream_id: "stream-u1",
            source_position: 1,
            block_position: 0,
            native_id: null,
            native_ordinal: null,
            timestamp: { value: 1000, provenance: "exact" },
            kind: "assistant_message",
            role: "assistant",
            channel: null,
            ownership_evidence: "recorded",
            preview: "Cached preview",
            block_availability: ["recorded"],
          },
        ],
        next_cursor: null,
        previous_cursor: null,
        anchor_index: null,
      },
    });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  await page.getByRole("button", { name: "Expand transcript entry entry-1" }).click();
  const body = page.getByTestId("transcript-body-entry-1");
  await expect(body.getByText("Cached full body")).toBeVisible();
  await emitSessionUpdate(page);
  await expect.poll(() => detailRequests).toBe(2);
  await expect(body.getByText("Cached full body")).toBeVisible();
  await expect(body.getByText("Refresh failed. The previously loaded content is still shown.")).toBeVisible();
  await body.getByRole("button", { name: "Refresh recorded content" }).click();
  await expect.poll(() => detailRequests).toBeGreaterThan(2);
  await expect(body.getByText("Cached full body")).toBeVisible();
});

test("two live transcript refreshes preserve the marked, expanded reading anchor", async ({ page }) => {
  await installFakeSessionEvents(page);
  let appendCount = 0;
  const bodyRequests: string[] = [];
  const anchorRequests: Array<string | null> = [];
  const pageResponses: Array<{ anchor: string | null; revision: number; ids: string[] }> = [];
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    anchorRequests.push(url.searchParams.get("anchor"));
    if (url.pathname.endsWith("/transcript/entries/target-entry")) {
      bodyRequests.push("target-entry");
      await route.fulfill({
        json: {
          entry_id: "target-entry",
          owner_id: "u1",
          source_stream_id: "stream-u1",
          source_position: 25,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: 25_000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: null,
          ownership_evidence: "recorded",
          preview: "Target preview",
          block_availability: ["recorded"],
          blocks: [{ kind: "text", native_type: null, text: "Target full body", data: null, availability: "recorded" }],
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          logical_stream_id: "stream-u1",
          source_request_id: null,
          invocation_id: null,
          event_id: null,
          subject_node_id: null,
          references: [],
        },
      });
      return;
    }

    const anchor = url.searchParams.get("anchor");
    const ids =
      anchor === "target-entry"
        ? [`before-target-${appendCount}`, "target-entry", `after-target-${appendCount}`]
        : anchor === "before-target-1"
          ? [`earlier-${appendCount}`, "before-target-1", "target-entry", `after-target-${appendCount}`]
          : appendCount === 0
            ? Array.from({ length: 50 }, (_, index) => (index === 24 ? "target-entry" : `base-${index}`))
            : Array.from({ length: 50 }, (_, index) => `appended-${appendCount}-${index}`);
    pageResponses.push({ anchor, revision: appendCount, ids });
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000 + appendCount,
        revision: `r${appendCount}`,
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: ids.map((entryId, index) => ({
          entry_id: entryId,
          owner_id: "u1",
          source_stream_id: "stream-u1",
          source_position: index + 1,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: index * 1000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: null,
          ownership_evidence: "recorded",
          preview: `${entryId} preview`,
          block_availability: ["recorded"],
        })),
        next_cursor: null,
        previous_cursor: null,
        anchor_index: anchor === "target-entry" ? 1 : null,
      },
    });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  const target = page.getByTestId("transcript-entry-target-entry");
  await expect(target).toBeVisible();
  await target.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await target.click();
  await target.getByRole("button", { name: "Expand transcript entry target-entry" }).click();
  await expect(page.getByText("Target full body")).toBeVisible();
  appendCount = 1;
  await emitSessionUpdate(page);
  await expect.poll(() => anchorRequests.includes("target-entry")).toBe(true);
  await expect(page.getByTestId("transcript-entry-target-entry")).toBeVisible();
  await expect(page.getByTestId("transcript-entry-before-target-1")).toBeVisible();
  await expect(page.getByTestId("transcript-entry-after-target-1")).toBeVisible();
  await expect(page.getByTestId("transcript-entry-target-entry")).toHaveAttribute("data-selection", "exact");
  await expect(page.getByRole("button", { name: "Collapse transcript entry target-entry" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const completedAnchorRequests = anchorRequests.filter((value) => value === "target-entry").length;
  appendCount = 2;
  await emitSessionUpdate(page);
  await expect
    .poll(() => anchorRequests.filter((value) => value === "target-entry").length)
    .toBeGreaterThan(completedAnchorRequests);
  await expect.poll(() => pageResponses.at(-1)?.revision).toBe(2);
  await expect(page.getByTestId("transcript-entry-before-target-1")).toBeVisible();
  await expect(page.getByTestId("transcript-entry-after-target-2")).toBeVisible();
  await expect(page.getByText("Target full body")).toBeVisible();
  expect(bodyRequests.every((entryId) => entryId === "target-entry")).toBe(true);
});

test("following latest advances to content appended after the current anchor", async ({ page }) => {
  await installFakeSessionEvents(page);
  let appended = false;
  const anchors: Array<string | null> = [];
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    const anchor = url.searchParams.get("anchor");
    anchors.push(anchor);
    const ids = !appended
      ? ["latest-1"]
      : anchor === "latest-2"
        ? ["latest-1", "latest-2"]
        : anchor === "latest-1"
          ? ["latest-1", "latest-2"]
          : ["latest-1"];
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: appended ? 1001 : 1000,
        revision: appended ? "r2" : "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: ids.map((entryId, index) => ({
          entry_id: entryId,
          owner_id: "u1",
          source_stream_id: "stream-u1",
          source_position: index + 1,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: index * 1000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: null,
          ownership_evidence: "recorded",
          preview: `${entryId} preview`,
          block_availability: ["recorded"],
        })),
        next_cursor: null,
        previous_cursor: null,
        anchor_index: anchor === null ? null : ids.indexOf(anchor),
      },
    });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  await expect(page.getByTestId("transcript-entry-latest-1")).toBeVisible();
  const scope = page.getByLabel("Search scope");
  await scope.selectOption("whole");
  await page.getByRole("searchbox", { name: "Search recorded content" }).fill("keep this draft");
  const follow = page.getByTestId("transcript-section").getByRole("button", { name: "Follow latest" });
  await follow.click();
  await expect(page.getByTestId("transcript-entry-latest-1")).toBeVisible();
  await expect(scope).toHaveValue("whole");
  await expect(page.getByRole("searchbox", { name: "Search recorded content" })).toHaveValue("keep this draft");

  await expect.poll(() => anchors.includes("latest-1")).toBe(true);
  appended = true;
  await emitSessionUpdate(page);
  await expect(page.getByTestId("transcript-entry-latest-2")).toBeVisible();
  await expect.poll(() => anchors.includes("latest-2")).toBe(true);
  await expect(
    page.getByTestId("transcript-section").getByRole("button", { name: "Following latest" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(scope).toHaveValue("whole");
  await expect(page.getByRole("searchbox", { name: "Search recorded content" })).toHaveValue("keep this draft");
});

for (const { scope, expectedNode } of [
  { scope: "own", expectedNode: "u1" },
  { scope: "whole", expectedNode: null },
]) {
  test(`a submitted ${scope} search retains selection, disclosure, and screen position through refresh states`, async ({
    page,
  }) => {
    await installFakeSessionEvents(page);
    let revision = 0;
    let failNext = false;
    const searches: Array<{ q: string | null; node: string | null }> = [];
    let releaseRefresh: (() => void) | undefined;
    let refreshStarted: (() => void) | undefined;
    await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/transcript/search")) {
        searches.push({ q: url.searchParams.get("q"), node: url.searchParams.get("node_id") });
        if (revision === 1 && !failNext) {
          refreshStarted?.();
          await new Promise<void>((resolve) => {
            releaseRefresh = resolve;
          });
        }
        if (failNext) {
          await route.fulfill({ status: 503, json: { detail: "Search refresh temporarily unavailable" } });
          return;
        }
        await route.fulfill({
          json: {
            session_id: SESSION,
            scope_id: url.searchParams.get("node_id"),
            mtime: 1000 + revision,
            revision: `search-r${revision}`,
            coverage: { source_present: true, categories: ["assistant"], reasons: [] },
            hits: ["reading-anchor", ...(revision > 0 ? ["appended-hit"] : [])].map((entryId, index) => ({
              entry_id: entryId,
              owner_id: "u1",
              kind: "assistant_message",
              role: "assistant",
              channel: "final",
              timestamp: { value: 1000 + index, provenance: "exact" },
              block_position: 0,
              snippet: `needle result ${entryId}`,
            })),
            next_cursor: null,
            previous_cursor: null,
          },
        });
        return;
      }
      if (url.pathname.endsWith("/transcript/entries/reading-anchor")) {
        await route.fulfill({
          json: {
            entry_id: "reading-anchor",
            owner_id: "u1",
            source_stream_id: "stream-u1",
            source_position: 1,
            block_position: 0,
            native_id: null,
            native_ordinal: null,
            timestamp: { value: 1000, provenance: "exact" },
            kind: "assistant_message",
            role: "assistant",
            channel: "final",
            ownership_evidence: "recorded",
            preview: "needle result reading-anchor",
            block_availability: ["recorded"],
            blocks: [
              { kind: "text", native_type: null, text: "needle body cached", data: null, availability: "recorded" },
            ],
            coverage: { source_present: true, categories: ["assistant"], reasons: [] },
            logical_stream_id: "stream-u1",
            source_request_id: null,
            invocation_id: null,
            event_id: null,
            subject_node_id: null,
            references: [],
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          session_id: SESSION,
          scope_id: "u1",
          mtime: 1000,
          revision: "page-r1",
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          entries: [],
          next_cursor: null,
          previous_cursor: null,
          anchor_index: null,
        },
      });
    });

    await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
    const section = page.getByTestId("transcript-section");
    const scopeControl = section.getByLabel("Search scope");
    const expectedScope = scope === "whole" ? "whole" : "owner";
    await section.getByRole("searchbox", { name: "Search recorded content" }).fill("needle");
    if (scope === "whole") await scopeControl.selectOption("whole");
    await section.getByRole("button", { name: "Search", exact: true }).click();
    await expect(scopeControl).toHaveValue(expectedScope);
    await expect(section.getByRole("searchbox", { name: "Search recorded content" })).toHaveValue("needle");
    await expect(page.getByText("needle result reading-anchor", { exact: true })).toBeVisible();
    const anchorRow = page.getByTestId("transcript-entry-reading-anchor");
    await anchorRow.click();
    await section.getByRole("button", { name: "Expand transcript entry reading-anchor" }).click();
    await expect(page.getByText("needle body cached", { exact: true })).toBeVisible();
    await anchorRow.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const initialTop = await anchorRow.evaluate((element) => element.getBoundingClientRect().top);

    revision = 1;
    const startedPromise = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    await emitSessionUpdate(page, 2);
    await startedPromise;
    await expect(scopeControl).toHaveValue(expectedScope);
    await expect(section.getByRole("searchbox", { name: "Search recorded content" })).toHaveValue("needle");
    await expect(anchorRow).toHaveAttribute("data-selection", "exact");
    await expect(section.getByRole("button", { name: "Collapse transcript entry reading-anchor" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(await anchorRow.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(initialTop, 0);
    releaseRefresh?.();
    await expect(page.getByText("needle result appended-hit", { exact: true })).toBeVisible();
    await expect(scopeControl).toHaveValue(expectedScope);
    await expect(section.getByRole("searchbox", { name: "Search recorded content" })).toHaveValue("needle");
    await expect.poll(() => searches.at(-1)?.q).toBe("needle");
    await expect.poll(() => searches.at(-1)?.node).toBe(expectedNode);
    expect(await anchorRow.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(initialTop, 0);

    failNext = true;
    const previousSearchCount = searches.length;
    await emitSessionUpdate(page, 3);
    await expect.poll(() => searches.length).toBeGreaterThan(previousSearchCount);
    await expect(page.getByText(/Transcript refresh failed/i)).toBeVisible();
    await expect(scopeControl).toHaveValue(expectedScope);
    await expect(section.getByRole("searchbox", { name: "Search recorded content" })).toHaveValue("needle");
    await expect(page.getByText("needle result reading-anchor", { exact: true })).toBeVisible();
    await expect(anchorRow).toHaveAttribute("data-selection", "exact");
    await expect(page.getByText("needle body cached", { exact: true })).toBeVisible();
    expect(await anchorRow.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(initialTop, 0);
    failNext = false;
    expect(searches.every(({ q, node }) => q === "needle" && node === expectedNode)).toBe(true);
    await section.getByRole("button", { name: "Refresh transcript" }).click();
    await expect(page.getByText("needle result appended-hit", { exact: true })).toBeVisible();
    await expect(scopeControl).toHaveValue(expectedScope);
    await expect(section.getByRole("searchbox", { name: "Search recorded content" })).toHaveValue("needle");
  });
}

test("a stale search cursor keeps the loaded result and recovers by explicit refresh", async ({ page }) => {
  let staleCursorSeen = false;
  const seen: Array<{ q: string | null; scope: string | null; after: string | null }> = [];
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/transcript/search")) {
      seen.push({
        q: url.searchParams.get("q"),
        scope: url.searchParams.get("node_id"),
        after: url.searchParams.get("after"),
      });
      if (url.searchParams.has("after")) {
        staleCursorSeen = true;
        await route.fulfill({ status: 409, json: { detail: "Search cursor no longer matches the transcript" } });
        return;
      }
      await route.fulfill({
        json: {
          session_id: SESSION,
          scope_id: "u1",
          mtime: 1000,
          revision: "stable-search",
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          hits: ["cached-hit", ...(staleCursorSeen ? ["recovered-hit"] : [])].map((entryId) => ({
            entry_id: entryId,
            owner_id: "u1",
            kind: "assistant_message",
            role: "assistant",
            channel: "final",
            timestamp: { value: 1000, provenance: "exact" },
            block_position: 0,
            snippet: `cached needle ${entryId}`,
          })),
          next_cursor: "stale-search-cursor",
          previous_cursor: null,
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "empty-page",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: [],
        next_cursor: null,
        previous_cursor: null,
        anchor_index: null,
      },
    });
  });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  const section = page.getByTestId("transcript-section");
  await section.getByRole("searchbox", { name: "Search recorded content" }).fill("needle");
  await section.getByLabel("Search scope").selectOption("whole");
  await section.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("cached needle cached-hit", { exact: true })).toBeVisible();
  const row = page.getByTestId("transcript-entry-cached-hit");
  await row.click();
  await expect(row).toHaveAttribute("data-selection", "exact");
  await section.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText(/Transcript refresh failed/i)).toBeVisible();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-selection", "exact");
  await expect(section.getByRole("searchbox", { name: "Search recorded content" })).toHaveValue("needle");
  await expect(section.getByLabel("Search scope")).toHaveValue("whole");
  await section.getByRole("button", { name: "Refresh transcript" }).click();
  await expect(page.getByText("cached needle recovered-hit", { exact: true })).toBeVisible();
  expect(seen.every((request) => request.q === "needle" && request.scope === null)).toBe(true);
  expect(seen.some((request) => request.after === "stale-search-cursor")).toBe(true);
  expect(seen.at(-1)?.after).toBe(null);
});

test("a stale filtered transcript page cursor keeps the disclosed window and refreshes from the start", async ({
  page,
}) => {
  const requests: URL[] = [];
  let staleCursorSeen = false;
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (url.pathname.endsWith("/transcript/entries/page-target")) {
      await route.fulfill({
        json: {
          entry_id: "page-target",
          owner_id: "u1",
          source_stream_id: "page-main",
          source_position: 1,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: 1000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: "final",
          ownership_evidence: "recorded",
          preview: "Page target",
          block_availability: ["recorded"],
          blocks: [
            { kind: "text", native_type: null, text: "page body retained", data: null, availability: "recorded" },
          ],
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          logical_stream_id: "page-main",
          source_request_id: null,
          invocation_id: null,
          event_id: null,
          subject_node_id: null,
          references: [],
        },
      });
      return;
    }
    if (url.pathname.endsWith("/transcript") && url.searchParams.has("after")) {
      staleCursorSeen = true;
      await route.fulfill({ status: 409, json: { detail: "Transcript cursor no longer matches the transcript" } });
      return;
    }
    const ids = staleCursorSeen
      ? ["page-before", "page-target", "page-newest"]
      : ["page-before", "page-target", "page-after"];
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "page-window",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: ids.map((entryId, index) => ({
          entry_id: entryId,
          owner_id: "u1",
          source_stream_id: "page-main",
          source_position: index,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: index, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: "final",
          ownership_evidence: "recorded",
          preview: entryId,
          block_availability: ["recorded"],
        })),
        next_cursor: "expired-page-cursor",
        previous_cursor: null,
        anchor_index: null,
      },
    });
  });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content&sel=call&owner=u1&call=id%3Amsg_3`);
  const section = page.getByTestId("transcript-section");
  const target = page.getByTestId("transcript-entry-page-target");
  await expect(target).toBeVisible();
  await target.click();
  await section.getByRole("button", { name: "Expand transcript entry page-target" }).click();
  await expect(page.getByText("page body retained", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText(/Transcript refresh failed/i)).toBeVisible();
  await expect(target).toBeVisible();
  await expect(target).toHaveAttribute("data-selection", "exact");
  await expect(page.getByText("page body retained", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Refresh transcript" }).click();
  await expect(page.getByTestId("transcript-entry-page-newest")).toBeVisible();
  await expect(target).toHaveAttribute("data-selection", "exact");
  await expect(page.getByText("page body retained", { exact: true })).toBeVisible();
  expect(requests.some((request) => request.searchParams.get("after") === "expired-page-cursor")).toBe(true);
  const refreshedPage = requests.at(-1);
  expect(refreshedPage?.searchParams.get("after")).toBe(null);
  expect(refreshedPage?.searchParams.get("call_key")).toBe("id:msg_3");
});

test("a true missing anchor reports 404, keeps the exact choice, and refreshes without substituting an owner", async ({
  page,
}) => {
  let anchorAttempts = 0;
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/transcript/entries/missing-entry")) {
      await route.fulfill({ status: 404, json: { detail: "unknown transcript entry" } });
      return;
    }
    if (url.pathname.endsWith("/transcript") && url.searchParams.has("anchor")) {
      anchorAttempts += 1;
      if (anchorAttempts === 1) {
        await route.fulfill({ status: 404, json: { detail: "unknown transcript anchor" } });
        return;
      }
      await route.fulfill({
        json: {
          session_id: SESSION,
          scope_id: "u1",
          mtime: 1000,
          revision: "recovered-anchor",
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          entries: ["left-neighbor", "replacement-owner-entry", "right-neighbor"].map((entryId, index) => ({
            entry_id: entryId,
            owner_id: entryId === "replacement-owner-entry" ? "u2" : "u1",
            source_stream_id: `stream-${index}`,
            source_position: index,
            block_position: 0,
            native_id: null,
            native_ordinal: null,
            timestamp: { value: index, provenance: "exact" },
            kind: "assistant_message",
            role: "assistant",
            channel: "final",
            ownership_evidence: "recorded",
            preview: entryId,
            block_availability: ["recorded"],
          })),
          next_cursor: null,
          previous_cursor: null,
          anchor_index: 1,
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "empty",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries:
          anchorAttempts > 0
            ? ["left-neighbor", "right-neighbor"].map((entryId, index) => ({
                entry_id: entryId,
                owner_id: "u1",
                source_stream_id: "stream-u1",
                source_position: index,
                block_position: 0,
                native_id: null,
                native_ordinal: null,
                timestamp: { value: index, provenance: "exact" },
                kind: "assistant_message",
                role: "assistant",
                channel: "final",
                ownership_evidence: "recorded",
                preview: entryId,
                block_availability: ["recorded"],
              }))
            : [],
        next_cursor: null,
        previous_cursor: null,
        anchor_index: null,
      },
    });
  });
  await page.goto(
    `/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content&sel=transcript&owner=u1&entry=missing-entry`,
  );
  await expect(page.getByText("This entry is no longer available in the transcript.")).toBeVisible();
  await expect(page.getByTestId("transcript-entry-replacement-owner-entry")).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh transcript" }).click();
  await expect(page.getByTestId("transcript-entry-left-neighbor")).toBeVisible();
  await expect(page.getByTestId("transcript-entry-right-neighbor")).toBeVisible();
  await expect(page.getByTestId("transcript-entry-replacement-owner-entry")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("entry")).toBe("missing-entry");
});

test("a supporting call opens Workflow and Back restores submitted search and disclosed body", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/transcript/search")) {
      await route.fulfill({
        json: {
          session_id: SESSION,
          scope_id: "u1",
          mtime: 1000,
          revision: "supporting-search",
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          hits: [
            {
              entry_id: "supporting-entry",
              owner_id: "u1",
              kind: "assistant_message",
              role: "assistant",
              channel: "final",
              timestamp: { value: 2000, provenance: "exact" },
              block_position: 0,
              snippet: "restorable needle result",
            },
          ],
          next_cursor: null,
          previous_cursor: null,
        },
      });
      return;
    }
    if (url.pathname.endsWith("/transcript/entries/supporting-entry")) {
      await route.fulfill({
        json: {
          entry_id: "supporting-entry",
          owner_id: "u1",
          source_stream_id: "native-main",
          source_position: 2,
          block_position: 0,
          native_id: "supporting-entry",
          native_ordinal: null,
          timestamp: { value: 2000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: "final",
          ownership_evidence: "recorded",
          preview: "restorable needle result",
          block_availability: ["recorded"],
          blocks: [
            { kind: "text", native_type: null, text: "supporting body text", data: null, availability: "recorded" },
          ],
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          logical_stream_id: "native-main",
          source_request_id: null,
          invocation_id: null,
          event_id: null,
          subject_node_id: null,
          references: [{ kind: "call", owner_id: "u1", key: "id:msg_3", label: "Supporting model call" }],
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "supporting-page",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: [],
        next_cursor: null,
        previous_cursor: null,
        anchor_index: null,
      },
    });
  });
  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  const section = page.getByTestId("transcript-section");
  await section.getByRole("searchbox", { name: "Search recorded content" }).fill("needle");
  await section.getByRole("button", { name: "Search", exact: true }).click();
  const row = page.getByTestId("transcript-entry-supporting-entry");
  await row.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await row.click();
  await section.getByRole("button", { name: "Expand transcript entry supporting-entry" }).click();
  await expect(page.getByText("supporting body text", { exact: true })).toBeVisible();
  const beforeTop = await row.evaluate((element) => element.getBoundingClientRect().top);
  await expect(page.getByRole("link", { name: "Show details: Supporting reference" })).toBeVisible();
  await page.getByRole("link", { name: "Show details: Supporting reference" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("workflow");
  await expect.poll(() => new URL(page.url()).searchParams.get("call")).toBe("id:msg_3");
  await expect(page.getByTestId("call-cost-u1-2")).toHaveAttribute("data-selection", "exact");
  await expect(page.getByTestId("call-cost-u1-2")).toContainText("LLM call 3");
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("content");
  await expect(section.getByRole("searchbox", { name: "Search recorded content" })).toHaveValue("needle");
  await expect(page.getByText("supporting body text", { exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: "Collapse transcript entry supporting-entry" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(await row.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(beforeTop, 0);
});

test("root-scope follow accepts entries owned by descendant turns", async ({ page }) => {
  await installFakeSessionEvents(page);
  await installDeepWorkflow(page, 1, 0, false, (session) => {
    session.root.node_id = "rootmain";
  });
  await installWorkflowDetail(page, "rootmain");
  let appended = false;
  await page.route(`**/api/sessions/${encodeURIComponent(WORKFLOW_SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    const anchor = url.searchParams.get("anchor");
    const entries = anchor === null ? ["turn-entry-1"] : ["turn-entry-1", "turn-entry-2"];
    await route.fulfill({
      json: {
        session_id: WORKFLOW_SESSION,
        scope_id: "rootmain",
        mtime: appended ? 2 : 1,
        revision: appended ? "r2" : "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: entries.map((entryId, index) => ({
          entry_id: entryId,
          owner_id: "turn",
          source_stream_id: "stream-turn",
          source_position: index + 1,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: index * 1000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: null,
          ownership_evidence: "recorded",
          preview: `${entryId} preview`,
          block_availability: ["recorded"],
        })),
        next_cursor: null,
        previous_cursor: null,
        anchor_index: anchor === null ? null : entries.indexOf(anchor),
      },
    });
  });

  await page.goto(`/sessions/${encodeURIComponent(WORKFLOW_SESSION)}?node=rootmain&tab=content`);
  await expect(page.getByTestId("transcript-entry-turn-entry-1")).toBeVisible();
  await page.getByTestId("transcript-section").getByRole("button", { name: "Follow latest" }).click();
  appended = true;
  await emitSessionUpdate(page);
  await expect(page.getByTestId("transcript-entry-turn-entry-2")).toBeVisible();
  await expect(page.getByRole("button", { name: "Following latest" })).toHaveAttribute("aria-pressed", "true");
});

test("root-scope failed refresh retains turn-owned visible content without recentering", async ({ page }) => {
  await installFakeSessionEvents(page);
  await installDeepWorkflow(page, 1, 0, false, (session) => {
    session.root.node_id = "rootmain";
  });
  await installWorkflowDetail(page, "rootmain");
  let failMetadata = false;
  const anchors: Array<string | null> = [];
  await page.route(`**/api/sessions/${encodeURIComponent(WORKFLOW_SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    const anchor = url.searchParams.get("anchor");
    anchors.push(anchor);
    if (url.pathname.endsWith("/transcript/entries/turn-entry-1")) {
      await route.fulfill({
        json: {
          entry_id: "turn-entry-1",
          owner_id: "turn",
          source_stream_id: "stream-turn",
          source_position: 1,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: 1000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: null,
          ownership_evidence: "recorded",
          preview: "Turn-owned preview",
          block_availability: ["recorded"],
          blocks: [
            { kind: "text", native_type: null, text: "Retained turn-owned body", data: null, availability: "recorded" },
          ],
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          logical_stream_id: "stream-turn",
          source_request_id: null,
          invocation_id: null,
          event_id: null,
          subject_node_id: null,
          references: [],
        },
      });
      return;
    }
    if (failMetadata) {
      await route.fulfill({ status: 503, json: { detail: "Transcript refresh failed" } });
      return;
    }
    await route.fulfill({
      json: {
        session_id: WORKFLOW_SESSION,
        scope_id: "rootmain",
        mtime: 1,
        revision: "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: [
          {
            entry_id: "turn-entry-1",
            owner_id: "turn",
            source_stream_id: "stream-turn",
            source_position: 1,
            block_position: 0,
            native_id: null,
            native_ordinal: null,
            timestamp: { value: 1000, provenance: "exact" },
            kind: "assistant_message",
            role: "assistant",
            channel: null,
            ownership_evidence: "recorded",
            preview: "Turn-owned preview",
            block_availability: ["recorded"],
          },
        ],
        next_cursor: null,
        previous_cursor: null,
        anchor_index: null,
      },
    });
  });

  await page.goto(`/sessions/${encodeURIComponent(WORKFLOW_SESSION)}?node=rootmain&tab=content`);
  const entry = page.getByTestId("transcript-entry-turn-entry-1");
  await expect(entry).toBeVisible();
  await entry.getByRole("button", { name: "Expand transcript entry turn-entry-1" }).click();
  await expect(page.getByText("Retained turn-owned body")).toBeVisible();
  failMetadata = true;
  await emitSessionUpdate(page);
  await expect(page.getByText(/refresh failed|transcript entry is unavailable/i)).toBeVisible();
  await expect(entry).toBeVisible();
  await expect(page.getByText("Retained turn-owned body")).toBeVisible();
  expect(anchors.every((anchor) => anchor === null)).toBe(true);
});

test("expanded body queries stay inactive while the Content tab is hidden", async ({ page }) => {
  await installFakeSessionEvents(page);
  let detailRequests = 0;
  await page.route(`**/api/sessions/${encodeURIComponent(SESSION)}/transcript**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/transcript/entries/entry-1")) {
      detailRequests += 1;
      await route.fulfill({
        json: {
          entry_id: "entry-1",
          owner_id: "u1",
          source_stream_id: "stream-u1",
          source_position: 1,
          block_position: 0,
          native_id: null,
          native_ordinal: null,
          timestamp: { value: 1000, provenance: "exact" },
          kind: "assistant_message",
          role: "assistant",
          channel: null,
          ownership_evidence: "recorded",
          preview: "Hidden body preview",
          block_availability: ["recorded"],
          blocks: [{ kind: "text", native_type: null, text: "Hidden full body", data: null, availability: "recorded" }],
          coverage: { source_present: true, categories: ["assistant"], reasons: [] },
          logical_stream_id: "stream-u1",
          source_request_id: null,
          invocation_id: null,
          event_id: null,
          subject_node_id: null,
          references: [],
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        session_id: SESSION,
        scope_id: "u1",
        mtime: 1000,
        revision: "r1",
        coverage: { source_present: true, categories: ["assistant"], reasons: [] },
        entries: [
          {
            entry_id: "entry-1",
            owner_id: "u1",
            source_stream_id: "stream-u1",
            source_position: 1,
            block_position: 0,
            native_id: null,
            native_ordinal: null,
            timestamp: { value: 1000, provenance: "exact" },
            kind: "assistant_message",
            role: "assistant",
            channel: null,
            ownership_evidence: "recorded",
            preview: "Hidden body preview",
            block_availability: ["recorded"],
          },
        ],
        next_cursor: null,
        previous_cursor: null,
        anchor_index: null,
      },
    });
  });

  await page.goto(`/sessions/${encodeURIComponent(SESSION)}?node=u1&tab=content`);
  await page.getByRole("button", { name: "Expand transcript entry entry-1" }).click();
  await expect(page.getByText("Hidden full body")).toBeVisible();
  const requestsBeforeHide = detailRequests;
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "Workflow", exact: true }).click();
  await expect(dialog.getByRole("tab", { name: "Workflow", exact: true })).toHaveAttribute("aria-selected", "true");
  await emitSessionUpdate(page);
  await page.waitForTimeout(200);
  expect(detailRequests).toBe(requestsBeforeHide);
  await dialog.getByRole("tab", { name: "Content", exact: true }).click();
  await expect(page.getByText("Hidden full body")).toBeVisible();
});
