// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { components } from "./schema";

type Schemas = components["schemas"];

export type SummaryOut = Schemas["SummaryOut"];
export type SessionOut = Schemas["SessionOut"];
export type NodeOut = Schemas["NodeOut"];
export type NodeDetailOut = Schemas["NodeDetailOut"];
export type MetricOut = Schemas["MetricOut"];
export type CostOut = Schemas["CostOut"];
export type TokensOut = Schemas["TokensOut"];
export type FindingOut = Schemas["FindingOut"];
export type LlmCallOut = Schemas["LlmCallOut"];
export type ToolOut = Schemas["ToolOut"];
export type ExecutionEventOut = Schemas["ExecutionEventOut"];
export type EventCallLinkOut = Schemas["EventCallLinkOut"];
