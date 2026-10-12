// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import type { components } from "./schema";

type Schemas = components["schemas"];

export type SummaryOut = Schemas["SummaryOut"];
export type SessionOut = Schemas["SessionOut"];
export type AgentSummaryRowOut = Schemas["AgentSummaryRowOut"];
export type NodeOut = Schemas["NodeOut"];
export type NodeDetailOut = Schemas["NodeDetailOut"];
export type MetricOut = Schemas["MetricOut"];
export type CostOut = Schemas["CostOut"];
export type TokensOut = Schemas["TokensOut"];
export type FindingOut = Schemas["FindingOut"];
export type FindingReferenceOut = Schemas["FindingReferenceOut"];
export type LlmCallOut = Schemas["LlmCallOut"];
export type ToolOut = Schemas["ToolOut"];
export type ExecutionEventOut = Schemas["ExecutionEventOut"];
export type EventCallLinkOut = Schemas["EventCallLinkOut"];
export type TranscriptBlockOut = Schemas["TranscriptBlockOut"];
export type TranscriptCoverageOut = Schemas["TranscriptCoverageOut"];
export type TranscriptEntryOut = Schemas["TranscriptEntryOut"];
export type TranscriptEntryDetailOut = Schemas["TranscriptEntryDetailOut"];
export type TranscriptPageOut = Schemas["TranscriptPageOut"];
export type TranscriptSearchHitOut = Schemas["TranscriptSearchHitOut"];
export type TranscriptSearchOut = Schemas["TranscriptSearchOut"];
