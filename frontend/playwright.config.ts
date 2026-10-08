// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { defineConfig } from "@playwright/test";

const PORT = 8791;

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: `uv run agentprof --no-browser --port ${PORT} --claude-root ../tests/adapters/claude_code/fixtures/projects --copilot-root ../tests/no-copilot-sessions --codex-root ../tests/no-codex-sessions`,
    url: `http://127.0.0.1:${PORT}/api/sessions`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
