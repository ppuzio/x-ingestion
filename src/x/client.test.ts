import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConversationSearchUrl,
  fetchUserPostsRaw,
  refreshXUserToken,
} from "./client.ts";

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
    const body = await fetchUserPostsRaw({
      bearerToken: "secret",
      userId: "123456789",
      collection: "likes",
      maxResults: 50,
    });

    assert.equal(body, rawBody);
    assert.equal(authorization, "Bearer secret");
    assert.equal(requestedUrl?.pathname, "/2/users/123456789/liked_tweets");
    assert.equal(requestedUrl?.searchParams.get("max_results"), "50");
    assert.match(requestedUrl?.searchParams.get("post.fields") ?? "", /entities/);
    assert.match(requestedUrl?.searchParams.get("expansions") ?? "", /referenced_posts/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("restricts full-archive thread search to one conversation and author", () => {
  const url = buildConversationSearchUrl(
    "1496273922714902528",
    "SeaRyanC",
    "2022-02-23T00:01:17.000Z",
  );
  assert.equal(url.pathname, "/2/tweets/search/all");
  assert.equal(url.searchParams.get("query"), "from:SeaRyanC");
  assert.equal(url.searchParams.get("start_time"), "2022-02-23T00:01:16.000Z");
  assert.equal(url.searchParams.get("end_time"), "2022-03-02T00:01:17.000Z");
  assert.equal(url.searchParams.get("max_results"), "500");
});

test("fetches a bookmarks page with a pagination token", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl: URL | undefined;
  globalThis.fetch = (async (input) => {
    requestedUrl = new URL(input.toString());
    return new Response('{"data":[],"meta":{"result_count":0}}', { status: 200 });
  }) as typeof fetch;

  try {
    await fetchUserPostsRaw({
      bearerToken: "secret",
      userId: "123456789",
      collection: "bookmarks",
      maxResults: 100,
      paginationToken: "next-page",
    });
    assert.equal(requestedUrl?.pathname, "/2/users/123456789/bookmarks");
    assert.equal(requestedUrl?.searchParams.get("pagination_token"), "next-page");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshes an expired OAuth user token", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = (async (_input, init) => {
    requestBody = String(init?.body);
    return new Response(
      JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const tokens = await refreshXUserToken("old-refresh", "client-id");
    assert.deepEqual(tokens, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    assert.equal(
      new URLSearchParams(requestBody).get("grant_type"),
      "refresh_token",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
