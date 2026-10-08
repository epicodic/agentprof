// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Text, Tooltip } from "@mantine/core";
import type { NodeOut } from "../api/types";
import { formatTokens, MISSING, withProvenance } from "../lib/format";

function compactionText(count: number): string {
  return count === 1 ? "1 compaction" : `${count} compactions`;
}

/** The node's peak context size; the tooltip adds the number of compactions. */
export function ContextCell({ node, color }: { node: NodeOut; color: string | null }) {
  const peak = node.context_peak;
  const text = peak.value === null ? MISSING : withProvenance(formatTokens(peak.value), peak);
  return (
    <Tooltip label={`peak ${text} · ${compactionText(node.compactions.length)}`} disabled={peak.value === null}>
      <Text
        size="xs"
        ta="right"
        c={peak.value === null ? "dimmed" : (color ?? "dimmed")}
        data-testid={`context-${node.node_id}`}
      >
        {text}
      </Text>
    </Tooltip>
  );
}
