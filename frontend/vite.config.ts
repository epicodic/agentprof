// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // A local tool: one ~200 kB (gzip) bundle is fine, no code splitting needed.
  build: { outDir: "../src/agentprof/server/static", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  server: { proxy: { "/api": "http://127.0.0.1:8765" } },
  test: { include: ["src/**/*.test.ts"] },
});
