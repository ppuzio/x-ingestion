import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fetchAndSaveCollection } from "./fetch-likes.ts";

test("paginates and preserves each raw response unchanged", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "x-ingestion-"));
  const originalFetch = globalThis.fetch;
  const paginationTokens: Array<string | null> = [];
  const bodies = [
    '{"data":[{"id":"1"}],"meta":{"next_token":"next"}}\n',
    '{"data":[{"id":"2"}],"meta":{}}\n',
  ];
  globalThis.fetch = (async (input) => {
    paginationTokens.push(new URL(input.toString()).searchParams.get("pagination_token"));
    return new Response(bodies[paginationTokens.length - 1], { status: 200 });
  }) as typeof fetch;

  try {
    const result = await fetchAndSaveCollection({
      bearerToken: "secret",
      userId: "123",
      collection: "bookmarks",
      maxPosts: 1_000,
      now: new Date("2026-01-02T03:04:05Z"),
      outputDirectory,
    });
    assert.equal(result.postCount, 2);
    assert.equal(result.paths.length, 2);
    assert.deepEqual(paginationTokens, [null, "next"]);
    assert.equal(await readFile(result.paths[0]!, "utf8"), bodies[0]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("stops after the first page whose posts were all captured before", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "x-ingestion-"));
  const originalFetch = globalThis.fetch;
  const bodies = [
    '{"data":[{"id":"new"},{"id":"1"}],"meta":{"next_token":"a"}}',
    '{"data":[{"id":"2"},{"id":"3"}],"meta":{"next_token":"b"}}',
    '{"data":[{"id":"4"}],"meta":{}}',
  ];
  let calls = 0;
  const pageSizes: Array<string | null> = [];
  globalThis.fetch = (async (input) => {
    pageSizes.push(new URL(input.toString()).searchParams.get("max_results"));
    return new Response(bodies[calls++], { status: 200 });
  }) as typeof fetch;

  try {
    const options = {
      bearerToken: "secret",
      userId: "123",
      collection: "likes" as const,
      now: new Date("2026-01-02T03:04:05Z"),
      outputDirectory,
    };
    const result = await fetchAndSaveCollection({
      ...options,
      knownIds: new Set(["1", "2", "3", "4"]),
    });
    assert.equal(calls, 2);
    assert.equal(result.paths.length, 2);
    assert.equal(result.reachedKnown, true);
    assert.deepEqual(pageSizes, ["10", "100"]);

    calls = 0;
    const full = await fetchAndSaveCollection({
      ...options,
      now: new Date("2026-01-03T03:04:05Z"),
      knownIds: new Set(),
    });
    assert.equal(calls, 3);
    assert.equal(full.reachedKnown, false);
    assert.deepEqual(pageSizes.slice(2), ["100", "100", "100"]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
