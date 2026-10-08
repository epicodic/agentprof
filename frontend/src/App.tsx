// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Route, Routes } from "react-router";
import { useSessionEvents } from "./api/events";
import { SessionListPage } from "./pages/SessionListPage";
import { SessionPage } from "./pages/SessionPage";

export function App() {
  useSessionEvents();
  return (
    <Routes>
      <Route path="/" element={<SessionListPage />} />
      <Route path="/sessions/:sessionId" element={<SessionPage />} />
    </Routes>
  );
}
