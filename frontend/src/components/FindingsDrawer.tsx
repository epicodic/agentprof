// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Badge, Drawer, Group, Stack, Text } from "@mantine/core";
import type { FindingOut, NodeOut } from "../api/types";
import { findingKey } from "../lib/findingGroups";
import { truncateTitle } from "../lib/format";
import { severityColor } from "../lib/severity";
import { findNode } from "../lib/tree";
import { DetailLink } from "./DetailLink";
import selectionClasses from "./EntitySelection.module.css";
import { type InspectionAction, useInspectionMenuTarget } from "./InspectionMenu";
import { useSessionInteraction } from "./SessionInteraction";

interface Props {
  opened: boolean;
  findings: FindingOut[];
  root: NodeOut;
  onClose: () => void;
  onReveal: (nodeId: string) => void;
}

export function FindingsDrawer({ opened, findings, root, onClose, onReveal }: Props) {
  const interaction = useSessionInteraction();
  const menuTarget = useInspectionMenuTarget((target) => {
    const key = target.closest<HTMLElement>("[data-testid^='finding-']")?.dataset.findingKey;
    const finding = findings.find((candidate, index) => findingKey(candidate, index) === key);
    return finding === undefined ? [] : findingActions(finding);
  });

  function findingActions(finding: FindingOut): InspectionAction[] {
    return [
      {
        id: `finding:${finding.node_id}:${finding.heuristic_id}:${finding.message}`,
        label: "Show details",
        run: () => onReveal(finding.node_id),
      },
    ];
  }

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="lg"
      title={truncateTitle(`Findings (${findings.length})`)}
    >
      <Stack gap={4} role="table" aria-label="Session findings">
        {findings.map((finding, index) => {
          const key = findingKey(finding, index);
          const topic = findNode(root, finding.node_id)?.topic ?? finding.node_id;
          const isMarked = interaction?.localMark?.viewKey === "session-findings" && interaction.localMark.key === key;
          return (
            <Group
              key={key}
              data-testid={`finding-${finding.heuristic_id}-${finding.node_id}`}
              data-finding-key={key}
              data-selection={isMarked ? "local" : "none"}
              role="row"
              aria-label={`Mark finding: ${finding.message}`}
              aria-selected={isMarked}
              className={selectionClasses.item}
              {...menuTarget}
              tabIndex={0}
              onKeyDown={(event) => {
                menuTarget.onKeyDown(event);
                if (event.defaultPrevented || event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  interaction?.markLocal("session-findings", key);
                }
              }}
              onClick={() => interaction?.markLocal("session-findings", key)}
              wrap="nowrap"
              align="flex-start"
              style={{
                borderRadius: 4,
                padding: 6,
                cursor: "default",
                background: isMarked ? "var(--mantine-color-blue-light)" : undefined,
              }}
            >
              <Badge role="cell" size="xs" color={severityColor(finding.severity)}>
                {finding.heuristic_id}
              </Badge>
              <Stack role="cell" gap={0} style={{ minWidth: 0, flex: 1 }}>
                <Text size="sm">
                  <DetailLink
                    label={finding.message}
                    entityRef={
                      interaction === null
                        ? null
                        : { kind: "node", sessionId: interaction.sessionId, nodeId: finding.node_id }
                    }
                    onOpen={() => onReveal(finding.node_id)}
                  >
                    {finding.message}
                  </DetailLink>
                </Text>
                <Text size="xs" c="dimmed" title={topic}>
                  {truncateTitle(topic)}
                </Text>
              </Stack>
            </Group>
          );
        })}
      </Stack>
    </Drawer>
  );
}
