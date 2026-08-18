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
