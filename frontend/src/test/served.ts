// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { SessionOut } from "../api/types";
import { withAgentRows } from "./agentRows";
import { withCallKeys } from "./callKeys";

/** A synthetic or modified session with the derived data the server would add. */
export function served(session: SessionOut): SessionOut {
  return withAgentRows(withCallKeys(session));
}
