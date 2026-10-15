// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { type Locator, type Page, test } from "@playwright/test";

const CAPTURE_FAILURE = /Protocol error \(Page\.captureScreenshot\)|Target crashed|Page crashed/;

/**
 * Save a reference screenshot into the test's output directory.
 * The screenshot is evidence, not an assertion: when the headless renderer cannot capture it (a protocol error after a
 * renderer crash), the test records an annotation and continues; any other error still fails the test.
 */
export async function saveScreenshot(
  target: Page | Locator,
  name: string,
  { fullPage = false }: { fullPage?: boolean } = {},
): Promise<void> {
  const info = test.info();
  const path = info.outputPath(name);
  try {
    await ("url" in target ? target.screenshot({ path, fullPage }) : target.screenshot({ path }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!CAPTURE_FAILURE.test(message)) throw error;
    info.annotations.push({ type: "screenshot-skipped", description: `${name}: ${message.split("\n")[0]}` });
  }
}
