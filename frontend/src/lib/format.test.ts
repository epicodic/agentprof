// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { describe, expect, it } from "vitest";
import { cost, metric, tokens } from "../test/factories";
import {
  agentLabel,
  costEvidenceLabel,
  formatCost,
  formatDuration,
  formatTokens,
  MISSING,
  totalTokens,
  truncateTitle,
  withProvenance,
} from "./format";

describe("formatDuration", () => {
  it("formats milliseconds, seconds, minutes and hours", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(12_340)).toBe("12.3s");
    expect(formatDuration(245_000)).toBe("4m 05s");
    expect(formatDuration(3_720_000)).toBe("1h 02m");
  });

  it("shows missing values as a dash", () => {
    expect(formatDuration(null)).toBe(MISSING);
    expect(formatDuration(undefined)).toBe(MISSING);
  });
});

describe("truncateTitle", () => {
  it("limits displayed titles to 100 characters including the ellipsis", () => {
    expect(truncateTitle("")).toBe("");
    expect(truncateTitle("a".repeat(100))).toBe("a".repeat(100));
    expect(truncateTitle(`${"a".repeat(100)}b`)).toBe(`${"a".repeat(99)}…`);
  });

  it("counts Unicode characters without splitting them", () => {
    expect(truncateTitle(`${"a".repeat(98)}😀extra`)).toBe(`${"a".repeat(98)}😀…`);
    expect(truncateTitle(`${"a".repeat(99)}😀`)).toBe(`${"a".repeat(99)}😀`);
  });
});

describe("formatTokens", () => {
  it("abbreviates thousands and millions", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(null)).toBe(MISSING);
  });
});

describe("formatCost", () => {
  it("formats dollars and credits", () => {
    expect(formatCost(cost(3.1914, "USD"))).toBe("$3.19");
    expect(formatCost(cost(0.0032, "USD"))).toBe("$0.0032");
    expect(formatCost(cost(42, "credits", "exact", 0.42))).toBe("$0.42 (42.0 cr)");
    expect(formatCost(cost(2.5, "credits", "exact", 0.025))).toBe("$0.03 (2.50 cr)");
    expect(formatCost(cost(0.5, "credits", "exact", 0.005))).toBe("$0.0050 (0.50 cr)");
    expect(formatCost(cost(42, "credits"))).toBe("42.0 cr");
  });

  it("shows missing costs as a dash", () => {
    expect(formatCost(cost())).toBe(MISSING);
    expect(formatCost(null)).toBe(MISSING);
  });
});

it("labels estimated USD distinctly from native credits", () => {
  expect(costEvidenceLabel(cost(0.01, "USD", "estimated"))).toBe("API-equivalent estimate");
  expect(costEvidenceLabel(cost(2, "credits"))).toBe("Native credits");
  expect(costEvidenceLabel(cost(1, "USD", "exact"))).toBe("Reported cost");
});

describe("withProvenance", () => {
  it("marks estimated values and leaves missing ones alone", () => {
    expect(withProvenance("$1.00", metric(1, "estimated"))).toBe("≈$1.00");
    expect(withProvenance("$1.00", metric(1, "exact"))).toBe("$1.00");
    expect(withProvenance(MISSING, metric())).toBe(MISSING);
  });
});

describe("totalTokens", () => {
  it("adds the available counts", () => {
    expect(totalTokens(tokens(10, 5))).toBe(15);
    expect(totalTokens(tokens())).toBeNull();
  });
});

describe("agentLabel", () => {
  it("maps known agents to a short label and leaves others unchanged", () => {
    expect(agentLabel("copilot-vscode")).toBe("Copilot");
    expect(agentLabel("claude-code")).toBe("Claude Code");
    expect(agentLabel("codex")).toBe("Codex");
    expect(agentLabel("codex-cli")).toBe("codex-cli");
  });
});
