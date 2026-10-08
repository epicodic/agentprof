// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { Alert, Anchor, Loader, Stack } from "@mantine/core";
import { Link, useParams } from "react-router";
import { useSession } from "../api/hooks";
import { SessionView } from "../components/SessionView";

export function SessionPage() {
  const { sessionId = "" } = useParams();
  const query = useSession(sessionId);
  if (query.isPending) return <Loader m="xl" />;
  if (query.isError) {
    return (
      <Stack p="md">
        <Anchor component={Link} to="/">
          ← Sessions
        </Anchor>
        <Alert color="red" title="Cannot load session">
          {query.error.message}
        </Alert>
      </Stack>
    );
  }
  return <SessionView key={sessionId} session={query.data} fetchedAtMs={query.dataUpdatedAt} />;
}
