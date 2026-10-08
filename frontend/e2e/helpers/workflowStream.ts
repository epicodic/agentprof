// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { createServer, type ServerResponse } from "node:http";
import type { SummaryOut } from "../../src/api/types";

export async function workflowStream(): Promise<{
  url: string;
  connected: Promise<void>;
  emit: (row: SummaryOut) => void;
  close: () => Promise<void>;
}> {
  const responses = new Set<ServerResponse>();
  let markConnected: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    markConnected = resolve;
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    response.flushHeaders();
    response.write(": connected\n\n");
    responses.add(response);
    response.on("close", () => responses.delete(response));
    markConnected();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No stream address");
  return {
    url: `http://127.0.0.1:${address.port}/api/sessions/events`,
    connected,
    emit: (row) => {
      for (const response of responses) response.write(`event: updated\ndata: ${JSON.stringify(row)}\n\n`);
    },
    close: async () => {
      for (const response of responses) response.end();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
