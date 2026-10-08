// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { expect, type Page, test } from "@playwright/test";
import type { NodeDetailOut, SessionOut } from "../../src/api/types";
import { cost, makeCall, makeNode, metric, tokens } from "../../src/test/factories";
import { deepWorkflow } from "../../src/test/workflowFixtures";

export const WORKFLOW_SESSION = "claude-code:11111111-1111-4111-8111-111111111111";
const workflowDetailFailures = new WeakMap<Page, string[]>();
const workflowSyntheticNodeIds = new WeakMap<Page, Set<string>>();
const workflowPublicNodeIds = new WeakMap<Page, Set<string>>();

function nodeIds(root: SessionOut["root"]): Set<string> {
  const ids = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    ids.add(node.node_id);
    pending.push(...node.children);
  }
  return ids;
}

export function workflowDetailFailuresFor(page: Page): readonly string[] {
  return workflowDetailFailures.get(page) ?? [];
}

export function consumeWorkflowDetailFailures(page: Page): string[] {
  const failures = workflowDetailFailures.get(page) ?? [];
  workflowDetailFailures.set(page, []);
  return failures;
}

export function assertNoUnexpectedWorkflowDetails(page: Page): void {
  expect(workflowDetailFailuresFor(page)).toEqual([]);
}

export async function assertNoSelectionActionControls(page: Page): Promise<void> {
  for (const name of [/^Select$/, /^Details$/, /^Open selected details$/, /^Reveal selection$/, /^Clear selection$/]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  }
  await expect(page.getByRole("columnheader", { name: "Details", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Open ancestor / })).toHaveCount(0);
  await expect(page.locator('[data-selection="associated"]')).toHaveCount(0);
}

test.afterEach(({ page }) => {
  assertNoUnexpectedWorkflowDetails(page);
});

export async function installDeepWorkflow(
  page: Page,
  depth = 20,
  siblings = 0,
  resumedAgent = false,
  transformSession?: (session: SessionOut) => void,
): Promise<void> {
  const sessionPath = `/api/sessions/${encodeURIComponent(WORKFLOW_SESSION)}`;
  workflowDetailFailures.set(page, []);
  workflowSyntheticNodeIds.set(page, new Set());
  workflowPublicNodeIds.set(page, new Set());
  await page.route(`**${sessionPath}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === sessionPath) {
      const response = await route.fetch();
      const session = (await response.json()) as SessionOut;
      const nativeNodeIds = nodeIds(session.root);
      workflowPublicNodeIds.set(page, nativeNodeIds);
      const extra = deepWorkflow(depth, siblings);
      const time = (session.root.start.value ?? 0) + 1000;
      const pending = [...extra.children];
      while (pending.length > 0) {
        const node = pending.pop();
        if (node === undefined) continue;
        for (const call of node.llm_calls) call.start = { value: time, provenance: "exact" };
        if (node.kind === "agent" && node.agent_id !== null) node.agent_id += 100;
        pending.push(...node.children);
      }
      if (resumedAgent) {
        const pendingScope = [...extra.children];
        let focusedOwner: typeof extra | undefined;
        while (pendingScope.length > 0) {
          const node = pendingScope.pop();
          if (node === undefined) continue;
          if (node.node_id === "deep-0") focusedOwner = node;
          pendingScope.push(...node.children);
        }
        focusedOwner?.children.push(
          makeNode({
            node_id: "resumed-inside",
            kind: "agent",
            agent_id: 202,
            topic: "Earlier resumed work",
            activity: "waiting",
            cost_own: cost(2, "USD"),
            tokens: tokens(11, 5),
            llm_calls: [
              makeCall({ call_id: "resume-inside-call", start: metric(time + 1), source_stream_id: "resume-inside" }),
            ],
          }),
        );
        extra.children.push(
          makeNode({
            node_id: "resumed-outside",
            kind: "agent",
            agent_id: 202,
            topic: "Later resumed work",
            activity: "running",
            cost_own: cost(3, "USD"),
            tokens: tokens(13, 7),
            llm_calls: [
              makeCall({ call_id: "resume-outside-call", start: metric(time + 2), source_stream_id: "resume-outside" }),
            ],
          }),
        );
      }
      session.root.children.push(...extra.children);
      transformSession?.(session);
      workflowSyntheticNodeIds.set(
        page,
        new Set([...nodeIds(session.root)].filter((nodeId) => !nativeNodeIds.has(nodeId))),
      );
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        json: session,
      });
      return;
    }
    const nodePrefix = `${sessionPath}/nodes/`;
    if (url.pathname.startsWith(nodePrefix)) {
      const nodeId = decodeURIComponent(url.pathname.slice(nodePrefix.length));
      if (workflowSyntheticNodeIds.get(page)?.has(nodeId) || !workflowPublicNodeIds.get(page)?.has(nodeId)) {
        const message =
          `Unexpected synthetic node detail request "${nodeId}". ` +
          `Install installWorkflowDetail(page, "${nodeId}") in this test.`;
        workflowDetailFailures.get(page)?.push(message);
        await route.abort("failed");
        return;
      }
      await route.fulfill({ response: await route.fetch() });
      return;
    }
    await route.fallback();
  });
}

export async function installWorkflowDetail(page: Page, nodeId: string): Promise<void> {
  const detail: NodeDetailOut = {
    node_id: nodeId,
    prompt: `Recorded task for ${nodeId}`,
    result: "Recorded synthetic result",
    arguments: {},
  };
  await page.route(
    `**/api/sessions/${encodeURIComponent(WORKFLOW_SESSION)}/nodes/${encodeURIComponent(nodeId)}`,
    (route) => route.fulfill({ json: detail }),
  );
}
