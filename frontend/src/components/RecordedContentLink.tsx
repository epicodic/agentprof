// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { QueryClientContext } from "@tanstack/react-query";
import { useContext } from "react";
import type { TranscriptPageOptions } from "../api/client";
import { useTranscriptPage } from "../api/hooks";
import type { EntityRef } from "../lib/entities";
import { DetailLink } from "./DetailLink";
import { useSessionInteraction } from "./SessionInteraction";

export function RecordedContentLink({
  ownerId,
  callKey,
  eventId,
  active,
  caption = "Recorded content",
}: {
  ownerId: string;
  callKey?: string;
  eventId?: string;
  active: boolean;
  caption?: string;
}) {
  const queryClient = useContext(QueryClientContext);
  if (queryClient === undefined) return null;
  return (
    <QueriedRecordedContentLink
      ownerId={ownerId}
      callKey={callKey}
      eventId={eventId}
      active={active}
      caption={caption}
    />
  );
}

function QueriedRecordedContentLink({
  ownerId,
  callKey,
  eventId,
  active,
  caption,
}: {
  ownerId: string;
  callKey?: string;
  eventId?: string;
  active: boolean;
  caption: string;
}) {
  const interaction = useSessionInteraction();
  const entityRef: EntityRef | null =
    interaction === null
      ? null
      : callKey !== undefined
        ? { kind: "call", sessionId: interaction.sessionId, ownerId, callKey }
        : eventId !== undefined
          ? { kind: "event", sessionId: interaction.sessionId, ownerId, eventId }
          : null;
  const options: TranscriptPageOptions =
    callKey !== undefined
      ? { nodeId: ownerId, limit: 1, callKey }
      : eventId !== undefined
        ? { nodeId: ownerId, limit: 1, eventId }
        : { nodeId: ownerId, limit: 1 };
  const query = useTranscriptPage(interaction?.sessionId ?? "", options, active && entityRef !== null);
  const entry = query.data?.entries.length === 1 ? query.data.entries[0] : null;
  if (interaction === null || entityRef === null || entry === null || entry.owner_id !== ownerId) return null;
  return (
    <DetailLink label={caption} entityRef={entityRef} destinationTab="content">
      {caption}
    </DetailLink>
  );
}
