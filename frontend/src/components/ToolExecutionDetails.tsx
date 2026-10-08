// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Anchor, Code, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";
import type { ExecutionEventOut } from "../api/types";
import type { CallRef, EntityRef } from "../lib/entities";
import { resolveEntity } from "../lib/entities";
import { formatDuration, formatTimestamp, withProvenance } from "../lib/format";
import { detailLink, recordedCallTargets } from "../lib/inspectionActions";
import type { ToolExecution } from "../lib/toolExecutions";
import classes from "./DetailTable.module.css";
import { useSessionInteraction } from "./SessionInteraction";

export function ToolExecutionDetails({
  execution,
  subjectRef,
  onJumpToCall,
}: {
  onJumpToCall: (ref: CallRef) => void;
  execution: ToolExecution;
  subjectRef: Extract<EntityRef, { kind: "node" }> | null;
}) {
  const interaction = useSessionInteraction();
  const subject = execution.subject;
  const pageLink = (ref: EntityRef) => {
    const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
    if (ref.kind === "node") params.set("tab", subject?.kind === "tool" ? "content" : "overview");
    return detailLink(`/sessions/${encodeURIComponent(ref.sessionId)}`, params, ref);
  };
  const related = (relation: "requested_by" | "consumed_by") =>
    interaction === null
      ? []
      : recordedCallTargets(interaction.root, interaction.sessionId, execution.events, relation);
  const callRelationship = (relation: "requested_by" | "consumed_by") => {
    const refs = related(relation);
    return (
      <div key={relation} style={{ marginTop: 6 }}>
        <Text size="11px" c="dimmed">
          {relation === "requested_by" ? "Requester" : "Result user"}
        </Text>
        {refs.length === 0 && (
          <Text size="xs" c="dimmed">
            Unavailable
          </Text>
        )}
        {refs.map((ref) => {
          const resolved = interaction === null ? null : resolveEntity(interaction.root, ref.sessionId, ref);
          return (
            <Anchor
              key={JSON.stringify(ref)}
              href={pageLink(ref)}
              size="xs"
              display="block"
              onClick={(event) => {
                event.stopPropagation();
                if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
                  event.preventDefault();
                  onJumpToCall(ref);
                }
              }}
            >
              LLM call {resolved?.index === null || resolved?.index === undefined ? "" : resolved.index + 1}
            </Anchor>
          );
        })}
      </div>
    );
  };
  return (
    <Stack gap="xs">
      <dl className={classes.mobileMetrics}>
        <div>
          <dt>Started</dt>
          <dd>
            {execution.startMs === null ? "Unavailable" : formatTimestamp(execution.startMs)}
            {callRelationship("requested_by")}
          </dd>
        </div>
        <div>
          <dt>Finished</dt>
          <dd>
            {execution.resultMs === null ? "Unavailable" : formatTimestamp(execution.resultMs)}
            {callRelationship("consumed_by")}
          </dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{withProvenance(formatDuration(execution.duration.value), execution.duration)}</dd>
        </div>
        <div>
          <dt>Outcome</dt>
          <dd>
            {execution.success === false
              ? "Failed"
              : execution.success === true
                ? "Succeeded"
                : !execution.resultRecorded && execution.pairing !== "node-only"
                  ? "Result not recorded"
                  : "Unavailable"}
          </dd>
        </div>
      </dl>
      {subject?.tool?.command && (
        <div>
          <Text size="xs" fw={600}>
            Command
          </Text>
          <Code block>{subject.tool.command}</Code>
        </div>
      )}
      {subject?.tool?.paths?.length || subject?.tool?.path ? (
        <div>
          <Text size="xs" fw={600}>
            Paths
          </Text>
          {[...new Set([...(subject.tool?.paths ?? []), ...(subject.tool?.path ? [subject.tool.path] : [])])].map(
            (path) => (
              <Text size="xs" key={path} style={{ overflowWrap: "anywhere" }}>
                {path}
              </Text>
            ),
          )}
        </div>
      ) : null}
      {subjectRef !== null ? (
        <Anchor
          href={pageLink(subjectRef)}
          size="xs"
          onClick={(event) => {
            event.stopPropagation();
            if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
              event.preventDefault();
              interaction?.openEntity(subjectRef);
            }
          }}
        >
          {subject?.kind === "tool" ? "Open tool details" : "Open agent details"}
        </Anchor>
      ) : (
        <Text size="xs" c="dimmed">
          Tool details unavailable
        </Text>
      )}
    </Stack>
  );
}

export function SourceEvidence({ events, children }: { events: readonly ExecutionEventOut[]; children?: ReactNode }) {
  return (
    <details>
      <summary>Source evidence</summary>
      <Stack gap="xs" mt="xs">
        {events.length === 0 && (
          <Text size="xs" c="dimmed">
            No source execution records available.
          </Text>
        )}
        {events.map((event, index) => (
          <div key={`${event.kind}:${event.event_id ?? index}`}>
            <Text size="xs" fw={600}>
              {event.kind === "tool_start"
                ? "Request"
                : event.kind === "tool_result"
                  ? "Result"
                  : event.kind.replaceAll("_", " ")}
            </Text>
            <dl className={classes.mobileMetrics}>
              <div>
                <dt>Event ID</dt>
                <dd>{event.event_id ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Subject ID</dt>
                <dd>{event.subject_node_id ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Recorded at</dt>
                <dd>
                  {formatTimestamp(event.start.value)} ({event.start.provenance})
                </dd>
              </div>
              <div>
                <dt>Execution start</dt>
                <dd>
                  {formatTimestamp(event.execution_start.value)} ({event.execution_start.provenance})
                </dd>
              </div>
              <div>
                <dt>Execution end</dt>
                <dd>
                  {formatTimestamp(event.execution_end.value)} ({event.execution_end.provenance})
                </dd>
              </div>
              <div>
                <dt>Source stream</dt>
                <dd>{event.source_stream_id ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Source order</dt>
                <dd>{event.source_order ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Recorded outcome</dt>
                <dd>{event.success === false ? "Failed" : event.success === true ? "Succeeded" : "Unavailable"}</dd>
              </div>
              {event.links.map((link) => (
                <div key={JSON.stringify(link)}>
                  <dt>
                    {link.relation.replaceAll("_", " ")} ({link.evidence})
                  </dt>
                  <dd>
                    Owner: {link.owner_id ?? "Unavailable"}
                    <br />
                    Request ID: {link.source_request_id}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
        {children}
      </Stack>
    </details>
  );
}
