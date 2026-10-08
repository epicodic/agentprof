// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Badge, Group, Stack, Table, Text, Title } from "@mantine/core";
import type { NodeOut } from "../api/types";
import { artifacts } from "../lib/artifacts";
import { truncateTitle } from "../lib/format";
import { findNode } from "../lib/tree";
import { DetailLink } from "./DetailLink";
import tableClasses from "./DetailTable.module.css";
import selectionClasses from "./EntitySelection.module.css";
import { type InspectionAction, useInspectionMenu, useInspectionMenuTarget } from "./InspectionMenu";
import { useSessionInteraction } from "./SessionInteraction";

/** Files written or edited by the node's own tool calls. */
export function ArtifactsTable({ node }: { node: NodeOut }) {
  const interaction = useSessionInteraction();
  const menu = useInspectionMenu();
  const files = artifacts(node);
  const menuTarget = useInspectionMenuTarget((target) => {
    const path = target.closest<HTMLTableRowElement>("[data-testid^='artifact-']")?.dataset.artifactPath;
    const file = files.find((candidate) => candidate.path === path);
    return file === undefined ? [] : producerActions(file.toolIds, file.path);
  });

  if (files.length === 0) return null;
  return (
    <Stack gap={4}>
      <Title order={5}>Artifacts</Title>
      <Table verticalSpacing={2} className={tableClasses.table}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Path</Table.Th>
            <Table.Th>Action</Table.Th>
            <Table.Th ta="right">Edits</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {files.map((file) => {
            const actions = producerActions(file.toolIds, file.path);
            return (
              <Table.Tr
                key={file.path}
                data-testid={`artifact-${file.path}`}
                data-artifact-path={file.path}
                data-selection={
                  interaction?.localMark?.viewKey === `artifact:${node.node_id}` &&
                  interaction.localMark.key === file.path
                    ? "local"
                    : "none"
                }
                className={selectionClasses.item}
                tabIndex={0}
                {...menuTarget}
                onClick={() => interaction?.markLocal(`artifact:${node.node_id}`, file.path)}
                onKeyDown={(event) => {
                  menuTarget.onKeyDown(event);
                  if (event.defaultPrevented || event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    interaction?.markLocal(`artifact:${node.node_id}`, file.path);
                  }
                }}
                style={{
                  cursor: "default",
                  background:
                    interaction?.localMark?.viewKey === `artifact:${node.node_id}` &&
                    interaction.localMark.key === file.path
                      ? "var(--mantine-color-blue-light)"
                      : undefined,
                }}
              >
                <Table.Td data-label="Path">
                  <Group gap={4} wrap="wrap" style={{ minWidth: 0, width: "100%" }}>
                    <Text
                      size="xs"
                      title={file.path}
                      className={tableClasses.topic}
                      style={{ minWidth: 0, flex: "1 1 120px", overflowWrap: "anywhere" }}
                    >
                      {interaction === null || actions.length === 0 ? (
                        truncateTitle(file.path)
                      ) : (
                        <DetailLink
                          label={file.path}
                          entityRef={
                            file.toolIds.length === 1
                              ? { kind: "node", sessionId: interaction.sessionId, nodeId: file.toolIds[0] }
                              : null
                          }
                          onOpen={(event) => {
                            if (file.toolIds.length === 1) actions[0].run();
                            else {
                              const element = event.currentTarget;
                              const rect = element.getBoundingClientRect();
                              menu.open({ x: rect.left, y: rect.bottom, actions, returnFocus: element });
                            }
                          }}
                        >
                          {file.path}
                        </DetailLink>
                      )}
                    </Text>
                    {file.failed && (
                      <Badge size="xs" color="red">
                        failed
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td data-label="Action">
                  <Text size="xs">{file.action}</Text>
                </Table.Td>
                <Table.Td ta="right" data-label="Edits">
                  <Text size="xs">{file.edits}</Text>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Stack>
  );

  function producerActions(toolIds: string[], path: string): InspectionAction[] {
    return toolIds.map((toolId) => {
      const producer = findNode(node, toolId);
      const label = producer === null ? `tool ${toolId}` : `${producer.tool?.native_id ?? "tool"}: ${producer.topic}`;
      return {
        id: `producer:${toolId}`,
        label: `Show producer: ${label}${toolIds.length > 1 ? ` (${path})` : ""}`,
        run: () => interaction?.openEntity({ kind: "node", sessionId: interaction.sessionId, nodeId: toolId }),
      };
    });
  }
}
