// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { cost, makeNode, makeSession } from "../test/factories";
import { SessionHeader } from "./SessionHeader";

test("shows estimated session cost without an API-equivalent label", () => {
  const root = makeNode({ node_id: "session", kind: "session", cost_total: cost(0.01, "USD", "estimated") });
  const html = renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(
        MemoryRouter,
        null,
        createElement(SessionHeader, {
          session: makeSession(root),
          findingCount: 0,
          findingsOnly: false,
          onFindingsOnly: () => {},
          onOpenFindings: () => {},
        }),
      ),
    ),
  );

  expect(html).toContain("≈$0.01");
  expect(html).not.toContain("API-equivalent estimate");
});

test("shows independent source, fetch and observation freshness timestamps", () => {
  const session = makeSession(makeNode({ node_id: "session", kind: "session" }), 1_760_000_000);
  const html = renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(
        MemoryRouter,
        null,
        createElement(SessionHeader, {
          session,
          findingCount: 0,
          findingsOnly: false,
          onFindingsOnly: () => {},
          onOpenFindings: () => {},
          fetchedAtMs: 1_760_000_001_000,
          latestObservedAtMs: 1_760_000_002_000,
        }),
      ),
    ),
  );

  expect(html).toContain("Source updated");
  expect(html).toContain("Fetched");
  expect(html).toContain("Latest observed activity");
  expect(html).not.toContain("Unavailable");
  expect(html).toContain(
    new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(new Date(1_760_000_000 * 1000)),
  );
  expect(html).toContain(
    new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(new Date(1_760_000_001_000)),
  );
});

test("marks missing freshness timestamps unavailable independently", () => {
  const html = renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(
        MemoryRouter,
        null,
        createElement(SessionHeader, {
          session: makeSession(makeNode({ node_id: "session", kind: "session" }), 0),
          findingCount: 0,
          findingsOnly: false,
          onFindingsOnly: () => {},
          onOpenFindings: () => {},
          fetchedAtMs: Number.NaN,
          latestObservedAtMs: null,
        }),
      ),
    ),
  );

  expect(html.match(/Unavailable/g)).toHaveLength(3);

  const partial = renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(
        MemoryRouter,
        null,
        createElement(SessionHeader, {
          session: makeSession(makeNode({ node_id: "session", kind: "session" }), 1_760_000_000),
          findingCount: 0,
          findingsOnly: false,
          onFindingsOnly: () => {},
          onOpenFindings: () => {},
          fetchedAtMs: 8.64e15 + 1,
          latestObservedAtMs: null,
        }),
      ),
    ),
  );
  expect(partial).toContain("Source updated");
  expect(partial).toContain("Unavailable");
  expect(partial.match(/Unavailable/g)).toHaveLength(2);
});
