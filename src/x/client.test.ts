import assert from "node:assert/strict";
import test from "node:test";

import { fetchLikedPostsRaw } from "./client.ts";

test("fetches the requested fields and returns the response body unchanged", async () => {
  const originalFetch = globalThis.fetch;
  const rawBody = '{"data":[{"id":"1","text":"hello"}]}\n';
  let requestedUrl: URL | undefined;
  let authorization: string | null = null;

  globalThis.fetch = (async (input, init) => {
    requestedUrl = new URL(input.toString());
    authorization = new Headers(init?.headers).get("Authorization");
    return new Response(rawBody, { status: 200 });
  }) as typeof fetch;

  try {
    const body = await fetchLikedPostsRaw({
      bearerToken: "secret",
      userId: "123456789",
    });

    assert.equal(body, rawBody);
    assert.equal(authorization, "Bearer secret");
    assert.equal(requestedUrl?.pathname, "/2/users/123456789/liked_tweets");
    assert.equal(requestedUrl?.searchParams.get("max_results"), "10");
    assert.match(requestedUrl?.searchParams.get("post.fields") ?? "", /entities/);
    assert.match(requestedUrl?.searchParams.get("expansions") ?? "", /referenced_posts/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
