// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "./MarkdownMessage";

describe("MarkdownMessage", () => {
  it("renders chat Markdown as semantic elements and keeps raw HTML inert", () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownMessage, {
        text: "# Reply\n\n**bold** and [a link](https://example.com)\n\n- first\n- second\n\n```ts\nconst n = 1;\n```\n\n| A | B |\n| - | - |\n| x | y |\n\n<script>alert(1)</script>",
      }),
    );
    expect(markup).toContain("<h1>Reply</h1>");
    expect(markup).toContain("<strong>bold</strong>");
    expect(markup).toContain('<a href="https://example.com">a link</a>');
    expect(markup).toContain("<ul>");
    expect(markup).toContain('<pre><code class="language-ts">const n = 1;');
    expect(markup).toContain("<table>");
    expect(markup).not.toContain("<script>");
  });
});
