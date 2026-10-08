// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { cost, makeNode, metric, tokens } from "../test/factories";
import { ChildNodesTable } from "./ChildNodesTable";

test("colors child metrics by column, compares costs in USD and leaves missing metrics uncolored", () => {
  const items = [0, 10, 20, null].map((value, index) => ({
    node: makeNode({
      node_id: `turn-${index}`,
      kind: "turn",
      duration: metric(value),
      tokens_total: tokens(value, value === null ? null : 0),
      cost_own: cost(value === null ? null : value * 100, "credits", undefined, value),
      cost_total: cost(value === null ? null : 20 - value, "USD"),
    }),
    offset: index * 1000,
  }));
  const html = renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(ChildNodesTable, {
        title: "Turns",
        testIdPrefix: "turn",
        items,
        mainAgentStart: 0,
        onSelect: () => {},
      }),
    ),
  );
  const row = (index: number) => html.match(new RegExp(`data-testid="turn-turn-${index}"[^]*?</tr>`))?.[0] ?? "";
  expect(row(0).match(/color:rgb\(92, 151, 106\)/g)).toHaveLength(3);
  expect(row(0).match(/color:rgb\(183, 108, 108\)/g)).toHaveLength(1);
  expect(row(1).match(/color:rgb\(168, 134, 56\)/g)).toHaveLength(4);
  expect(row(2).match(/color:rgb\(183, 108, 108\)/g)).toHaveLength(3);
  expect(row(3)).not.toContain("color:rgb");
});
