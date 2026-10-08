// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: 1, refetchOnWindowFocus: false } },
});

const container = document.getElementById("root");
if (container === null) {
  throw new Error("missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
