// SPDX-License-Identifier: MIT
// Copyright (c) 2026 epicodic

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchTranscript,
  fetchTranscriptEntry,
  fetchTranscriptSearch,
  queryKeys,
  type TranscriptPageOptions,
} from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("transcript API", () => {
  it("encodes path IDs and valid page options", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchTranscript("session /雪", {
      nodeId: "node & one",
      limit: 37,
      after: "cursor/?+",
      callKey: "id:call /1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session%20%2F%E9%9B%AA/transcript?node_id=node+%26+one&limit=37&after=cursor%2F%3F%2B&call_key=id%3Acall+%2F1",
    );
    await fetchTranscript("s", { anchor: "entry #1", eventId: "event&1" });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/sessions/s/transcript?anchor=entry+%231&event_id=event%261");
  });

  // @ts-expect-error Cursor and anchor pagination modes cannot be combined.
  const invalidPageOptions: TranscriptPageOptions = { after: "cursor", anchor: "entry" };
  void invalidPageOptions;

  it("uses no query string for whole-session scope and normalizes equivalent option objects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchTranscript("s");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s/transcript");
    expect(queryKeys.transcriptPage("s", { nodeId: "owner", after: undefined })).toEqual(
      queryKeys.transcriptPage("s", { nodeId: "owner" }),
    );
  });

  it("encodes search and entry IDs and exposes HTTP status on errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "entry vanished" }), { status: 409, statusText: "Conflict" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await fetchTranscriptSearch("s", { q: "snow 雪& rain", nodeId: "n /", limit: 10, after: "next+" });
    await fetchTranscriptEntry("s /", "entry /雪");
    await expect(fetchTranscriptEntry("s", "gone")).rejects.toMatchObject({ status: 409, message: "entry vanished" });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/sessions/s/transcript/search?q=snow+%E9%9B%AA%26+rain&node_id=n+%2F&limit=10&after=next%2B",
    );
    expect(fetchMock.mock.calls[1][0]).toBe("/api/sessions/s%20%2F/transcript/entries/entry%20%2F%E9%9B%AA");
  });

  it("separates transcript cache keys by session, scope, filters and cursor while sharing a prefix", () => {
    const prefix = queryKeys.transcripts("s");
    const root = queryKeys.transcriptPage("s", {});
    expect(root.slice(0, prefix.length)).toEqual(prefix);
    expect(queryKeys.transcriptPage("other", {})).not.toEqual(root);
    expect(queryKeys.transcriptPage("s", { nodeId: "owner" })).not.toEqual(root);
    expect(queryKeys.transcriptPage("s", { callKey: "id:c" })).not.toEqual(root);
    expect(queryKeys.transcriptPage("s", { eventId: "e" })).not.toEqual(root);
    expect(queryKeys.transcriptPage("s", { after: "cursor" })).not.toEqual(root);
    expect(queryKeys.transcriptPage("s", { anchor: "entry" })).not.toEqual(root);
    expect(queryKeys.transcriptSearch("s", { q: "needle", nodeId: "owner" })).not.toEqual(
      queryKeys.transcriptSearch("s", { q: "needle" }),
    );
    expect(queryKeys.transcriptEntry("s", "entry")).not.toEqual(queryKeys.transcriptEntry("s", "other"));
  });
});
