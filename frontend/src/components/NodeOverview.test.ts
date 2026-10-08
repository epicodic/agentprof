// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { cost, makeCall, makeNode, metric, tokens } from "../test/factories";
import { NodeOverview } from "./NodeOverview";

function render(
  node: ReturnType<typeof makeNode>,
  detail?: { node_id: string; prompt: string; result: string; arguments: Record<string, unknown> },
): string {
  return renderToStaticMarkup(createElement(MantineProvider, null, createElement(NodeOverview, { node, detail })));
}

test("shows token metrics with own and descendant totals", () => {
  const node = makeNode({
    node_id: "agent",
    kind: "agent",
    tokens: { ...tokens(10, 20), cache_write: metric(4), cache_write_5m: metric(2), cache_write_1h: metric(2) },
    tokens_total: { ...tokens(30, 40), cache_write: metric(8), cache_write_5m: metric(5), cache_write_1h: metric(3) },
  });

  const html = render(node);

  expect(html).toContain("Metric details");
  expect(html).toContain("Own");
  expect(html).toContain("Including descendants");
  expect(html).toContain("Cache write 5m");
  expect(html).toContain("Cache write 1h");
  expect(html).toContain('data-testid="metrics-tokens"');
  for (const [label, own, total] of [
    ["Input", "10", "30"],
    ["Output", "20", "40"],
    ["Cache write 5m", "2", "5"],
    ["Cache write 1h", "2", "3"],
  ]) {
    expect(html).toMatch(new RegExp(`<tr[^>]*><th[^>]*>${label}</th><td[^>]*>${own}</td><td[^>]*>${total}</td></tr>`));
  }
});

test("shows session own cost from its turn calls", () => {
  const turn = makeNode({
    node_id: "turn",
    kind: "turn",
    llm_calls: [makeCall({ cost: cost(0.25, "USD", "estimated") })],
  });
  const node = makeNode({ node_id: "session", kind: "session", children: [turn] });

  const html = render(node);

  expect(html).toContain("≈$0.25");
  expect(html).toContain('data-testid="metrics-cost-own"');
  expect(html.match(/data-testid="metrics-llm-calls"[^>]*>([^<]*)</)?.[1]).toBe("1");
});

test("shows failed tool status and missing duration", () => {
  const node = makeNode({ node_id: "tool", kind: "tool", success: false, duration: metric() });

  const html = render(node);

  expect(html).toContain("Failed");
  expect(html.match(/Duration<\/p><p[^>]*>([^<]*)<\/p>/)?.[1]).toBe("–");
});
