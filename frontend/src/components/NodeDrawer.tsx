// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Alert, Badge, Button, Code, Drawer, Group, Loader, Stack, Tabs, Text, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useEffect, useMemo, useState } from "react";
import { useNode } from "../api/hooks";
import type { NodeDetailOut, NodeOut } from "../api/types";
import { drawerTimeDomain } from "../lib/drawerTimeDomain";
import { resolveEntity } from "../lib/entities";
import { truncateTitle } from "../lib/format";
import { type DetailTab, detailTab } from "../lib/inspectionLocation";
import { subAgents, turns } from "../lib/tree";
import { buildWorkflowIndex, type WorkflowIndex, workflowAncestors } from "../lib/workflowScope";
import { observeWorkflow } from "../lib/workflowState";
import { ArtifactsTable } from "./ArtifactsTable";
import { ChildNodesTable } from "./ChildNodesTable";
import { ContextSection } from "./ContextSection";
import { CostSection } from "./CostSection";
import { LlmCallsTable } from "./LlmCallsTable";
import classes from "./NodeDrawer.module.css";
import { NodeFindings } from "./NodeFindings";
import { NodeOverview } from "./NodeOverview";
import { NodeTimeline } from "./NodeTimeline";
import {
  type FocusRequest,
  focusRequestToken,
  useInspectionMemory,
  usePanelReadingPosition,
  useSessionInteraction,
} from "./SessionInteraction";
import { WorkflowBreadcrumbs } from "./WorkflowBreadcrumbs";
import { WorkflowStatus } from "./WorkflowStatus";

interface Props {
  sessionId: string;
  node: NodeOut | null;
  parentId: string | null;
  mainAgentStart: number | null;
  workflowIndex?: WorkflowIndex;
  onSelect: (nodeId: string) => void;
  onClose: () => void;
}

export function SessionCallsSequence({
  node,
  mainAgentStart,
  onSelect,
  focusedEntity,
}: {
  node: NodeOut;
  mainAgentStart: number | null;
  onSelect: (nodeId: string) => void;
  focusedEntity: FocusRequest | null;
}) {
  return (
    <LlmCallsTable
      node={node}
      agentStart={node.start.value ?? mainAgentStart}
      onSelect={onSelect}
      focusRequest={focusedEntity?.ownerId === node.node_id ? focusedEntity : null}
      title="Root execution sequence"
      tableRole="calls-root"
    />
  );
}

function TextBlock({ title, text }: { title: string; text: string }) {
  if (text === "") return null;
  return (
    <Stack gap={4}>
      <Title order={5}>{title}</Title>
      <Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 400, overflow: "auto" }}>
        {text}
      </Code>
    </Stack>
  );
}

function DetailTexts({ detail }: { detail: NodeDetailOut }) {
  const argumentsText = Object.keys(detail.arguments).length > 0 ? JSON.stringify(detail.arguments, null, 2) : "";
  return (
    <>
      <TextBlock title="Prompt" text={detail.prompt} />
      <TextBlock title="Result" text={detail.result} />
      <TextBlock title="Arguments" text={argumentsText} />
    </>
  );
}

export function NodeDrawer({
  sessionId,
  node,
  parentId,
  mainAgentStart,
  workflowIndex: sharedWorkflowIndex,
  onSelect,
  onClose,
}: Props) {
  const detail = useNode(sessionId, node?.node_id ?? null);
  const interaction = useSessionInteraction();
  const workflowRoot = interaction?.root;
  const workflowIndex = useMemo(
    () => sharedWorkflowIndex ?? (workflowRoot === undefined ? null : buildWorkflowIndex(workflowRoot)),
    [sharedWorkflowIndex, workflowRoot],
  );
  const [localTab, setLocalTab] = useState<DetailTab | null>(node?.kind === "tool" ? "content" : "overview");
  const tab =
    node === null ? localTab : detailTab(node.kind, interaction === null ? localTab : interaction.location.tab);
  const setTab = (value: string | null) => {
    if (value === null) return;
    if (value === "overview" || value === "workflow" || value === "calls" || value === "content") {
      setLocalTab(value);
      interaction?.changeTab(value);
    }
  };
  const request = interaction?.inspectionRequest ?? null;
  const inspected =
    interaction === null || request === null ? null : resolveEntity(interaction.root, sessionId, request.ref);
  const focusedEntity: FocusRequest | null =
    interaction === null || request === null || inspected?.index === null || inspected?.index === undefined
      ? null
      : request.ref.kind === "event" && inspected.event !== null
        ? {
            kind: "event",
            ownerId: request.ref.ownerId,
            eventId: request.ref.eventId,
            index: inspected.index,
            version: request.version,
          }
        : request.ref.kind === "call" && inspected.call !== null
          ? {
              kind: "call",
              ownerId: request.ref.ownerId,
              callKey: request.ref.callKey,
              expand: request.expandCall,
              index: inspected.index,
              version: request.version,
            }
          : null;
  const [standaloneFocus, setStandaloneFocus] = useState<{ ownerId: string; index: number } | null>(null);
  const callFocus: FocusRequest | null =
    interaction === null ? (standaloneFocus === null ? null : { kind: "call", ...standaloneFocus }) : focusedEntity;
  const narrow = useMediaQuery("(max-width: 48em)");
  const [width, setWidth] = useInspectionMemory("drawer:width", () => 60);
  const [fullWidth, setFullWidth] = useInspectionMemory("drawer:full-width", () => false);
  const nodeId = node?.node_id ?? "none";
  const ancestry = node === null || workflowIndex === null ? [] : workflowAncestors(workflowIndex, node.node_id);
  const observation = node === null ? null : (workflowIndex?.observations.get(node.node_id) ?? observeWorkflow([node]));
  const overviewPosition = usePanelReadingPosition(`${nodeId}:overview`, tab === "overview");
  const workflowPosition = usePanelReadingPosition(`${nodeId}:workflow`, tab === "workflow");
  const view = useMemo(() => (node === null ? null : drawerTimeDomain(node)), [node]);
  const origin = node?.start.value !== null && Number.isFinite(node?.start.value) ? node?.start.value : view?.start;
  const [childrenOpen, setChildrenOpen] = useInspectionMemory(`${nodeId}:workflow-children-open`, () => true);
  const [callsOpen, setCallsOpen] = useInspectionMemory(`${nodeId}:workflow-calls-open`, () => true);
  const focusToken = callFocus === null ? null : focusRequestToken(callFocus);
  const [handledFocus, setHandledFocus] = useInspectionMemory<string | null>(`${nodeId}:workflow-section-focus`, () =>
    interaction?.restoringHistory ? focusToken : null,
  );
  useEffect(() => {
    if (
      node === null ||
      tab !== "workflow" ||
      callFocus === null ||
      focusToken === null ||
      focusToken === handledFocus ||
      interaction?.restoringHistory
    )
      return;
    const mainOwner =
      callFocus.ownerId === node.node_id ||
      (node.kind === "session" && turns(node).some(({ node: child }) => child.node_id === callFocus.ownerId));
    if (mainOwner) setCallsOpen(true);
    else setChildrenOpen(true);
    setHandledFocus(focusToken);
  }, [
    node,
    tab,
    callFocus,
    focusToken,
    handledFocus,
    interaction?.restoringHistory,
    setCallsOpen,
    setChildrenOpen,
    setHandledFocus,
  ]);
  const contentPosition = usePanelReadingPosition(`${nodeId}:content`, tab === "content");
  const drawerTitle = node?.kind === "tool" ? (node.tool?.native_id ?? "Tool") : (node?.topic ?? "");
  useEffect(() => {
    setLocalTab(node?.kind === "tool" ? "content" : "overview");
  }, [node?.kind]);
  return (
    <Drawer
      opened={node !== null}
      onClose={onClose}
      position="right"
      closeButtonProps={{ "aria-label": "Close details" }}
      size={narrow || fullWidth ? "100%" : `${width}%`}
      styles={{
        content: { display: "flex", flexDirection: "column", height: "100dvh" },
        header: { flexShrink: 0 },
        body: { display: "flex", flex: 1, minHeight: 0, overflow: "hidden" },
      }}
      title={
        <Group gap="sm" wrap="wrap">
          <Text title={drawerTitle}>{truncateTitle(drawerTitle)}</Text>
          {parentId !== null && (
            <Button size="xs" variant="subtle" onClick={() => onSelect(parentId)}>
              To parent
            </Button>
          )}
          {!narrow && (
            <>
              <Button size="xs" variant="subtle" onClick={() => setFullWidth((value) => !value)}>
                {fullWidth ? "Restore width" : "Expand details"}
              </Button>
              {!fullWidth && (
                <label className={classes.widthControl}>
                  Detail width
                  <input
                    type="range"
                    min="45"
                    max="90"
                    value={width}
                    onChange={(event) => setWidth(Number(event.currentTarget.value))}
                  />
                </label>
              )}
            </>
          )}
        </Group>
      }
    >
      {node !== null && (
        <Stack gap="sm" className={classes.shell} data-testid="node-detail-shell">
          <Group gap="xs">
            <Badge>{node.kind}</Badge>
            {observation !== null && <WorkflowStatus observation={observation} />}
            {node.model !== null && <Badge variant="light">{node.model}</Badge>}
            {node.tool !== null && (
              <Badge variant="outline">
                {node.tool.native_id} · {node.tool.category}
              </Badge>
            )}
          </Group>
          <WorkflowBreadcrumbs
            ancestors={ancestry}
            label="Inspected ancestry"
            sessionId={sessionId}
            onInspect={(ancestorId) => interaction?.openNode(ancestorId)}
          />
          <Tabs
            value={tab}
            onChange={setTab}
            keepMounted
            classNames={{ root: classes.tabs, list: classes.tabList, panel: classes.panel }}
          >
            <Tabs.List>
              <Tabs.Tab value="overview">Overview</Tabs.Tab>
              {node.kind !== "tool" && <Tabs.Tab value="workflow">Workflow</Tabs.Tab>}
              <Tabs.Tab value="content">Content</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel ref={overviewPosition.ref} onScroll={overviewPosition.onScroll} value="overview" pt="sm">
              <Stack gap="sm">
                <NodeOverview node={node} detail={detail.data} />
                <Button variant="subtle" size="xs" onClick={() => setTab("content")}>
                  Open full content
                </Button>
                <NodeFindings findings={node.findings} />
              </Stack>
            </Tabs.Panel>

            {node.kind !== "tool" && (
              <Tabs.Panel ref={workflowPosition.ref} onScroll={workflowPosition.onScroll} value="workflow" pt="sm">
                <Stack gap="sm">
                  <div className={classes.chartsScroll} data-testid="workflow-charts">
                    <Stack gap="sm" className={classes.chartsSurface}>
                      <NodeTimeline node={node} onSelect={onSelect} view={view} origin={origin} />
                      <CostSection
                        node={node}
                        view={view}
                        origin={origin}
                        onFocus={(event) => {
                          if (interaction !== null) return;
                          setStandaloneFocus({ ownerId: event.owner.node_id, index: event.index });
                        }}
                      />
                      <ContextSection node={node} view={view} origin={origin} />
                    </Stack>
                  </div>
                  {(turns(node).length > 0 || subAgents(node).length > 0) && (
                    <details
                      data-testid="workflow-children"
                      open={childrenOpen}
                      onToggle={(event) => setChildrenOpen(event.currentTarget.open)}
                    >
                      <summary>Sub-agents</summary>
                      <Stack gap="sm">
                        <ChildNodesTable
                          title="Turns"
                          testIdPrefix="turn"
                          items={turns(node)}
                          mainAgentStart={mainAgentStart}
                          onSelect={onSelect}
                          focusedEntity={callFocus}
                          inspectionNodeId={node.node_id}
                          hierarchical
                          tableRole="workflow"
                        />
                        <ChildNodesTable
                          title=""
                          testIdPrefix="sub-agent"
                          items={subAgents(node)}
                          mainAgentStart={mainAgentStart}
                          onSelect={onSelect}
                          focusedEntity={callFocus}
                          inspectionNodeId={node.node_id}
                          hierarchical
                          tableRole="workflow"
                        />
                      </Stack>
                    </details>
                  )}
                  <details
                    data-testid="workflow-calls"
                    open={callsOpen}
                    onToggle={(event) => setCallsOpen(event.currentTarget.open)}
                  >
                    <summary>LLM calls</summary>
                    {node.kind === "session" ? (
                      <>
                        <SessionCallsSequence
                          node={node}
                          mainAgentStart={mainAgentStart}
                          onSelect={onSelect}
                          focusedEntity={callFocus}
                        />
                        <ChildNodesTable
                          title="Turns"
                          testIdPrefix="call-turn"
                          callIdPrefix="expand-call-turn"
                          items={turns(node)}
                          mainAgentStart={mainAgentStart}
                          onSelect={onSelect}
                          focusedEntity={callFocus}
                          inspectionNodeId={node.node_id}
                          tableRole="calls"
                        />
                      </>
                    ) : (
                      <LlmCallsTable
                        title=""
                        node={node}
                        agentStart={node.kind === "agent" ? node.start.value : mainAgentStart}
                        onSelect={onSelect}
                        focusRequest={callFocus?.ownerId === node.node_id ? callFocus : null}
                        tableRole="calls"
                      />
                    )}
                  </details>
                </Stack>
              </Tabs.Panel>
            )}

            <Tabs.Panel ref={contentPosition.ref} onScroll={contentPosition.onScroll} value="content" pt="sm">
              <Stack gap="sm">
                <ArtifactsTable node={node} />
                {detail.isPending && <Loader size="sm" data-testid="node-detail-loading" />}
                {detail.isError && <Alert color="red">{detail.error.message}</Alert>}
                {detail.data !== undefined && <DetailTexts detail={detail.data} />}
              </Stack>
            </Tabs.Panel>
          </Tabs>
        </Stack>
      )}
    </Drawer>
  );
}
