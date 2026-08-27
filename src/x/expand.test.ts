import assert from "node:assert/strict";
import test from "node:test";

import type { SavedPost } from "../model.ts";
import {
  externalUrlsForPost,
  needsRelationshipContext,
  sourceGapsForPost,
  shouldExpandThread,
} from "./expand.ts";

function post(text: string, relationships: SavedPost["relationships"] = []): SavedPost {
  return {
    id: "1",
    url: "https://x.com/example/status/1",
    capturedAt: "2026-08-24T00:00:00Z",
    author: { id: "author" },
    fragments: [{ kind: "text", source: "post", text }],
    relationships,
    captureMethods: ["like"],
    rawSources: [],
  };
}

test("automatic thread expansion requires an explicit thread signal", () => {
  assert.equal(shouldExpandThread(post("A useful thread 🧵")), true);
  assert.equal(shouldExpandThread(post("Part 2/7 explains the result")), true);
  assert.equal(shouldExpandThread(post("A standalone post about APIs")), false);
});

test("external link expansion deduplicates X-owned links and repeats", () => {
  const urls = externalUrlsForPost(
    post("Read https://t.co/short", [
      {
        type: "replied_to",
        postId: "2",
        url: "https://x.com/example/status/2",
        links: [
          { kind: "link", source: "post", url: "https://example.com/article" },
          { kind: "link", source: "post", url: "https://example.com/article" },
          { kind: "link", source: "post", url: "https://twitter.com/example/status/3" },
        ],
      },
    ]),
  );
  assert.deepEqual(urls, ["https://example.com/article"]);
});

test("fetches missing or URL-only quoted context without crawling ordinary quotes", () => {
  assert.equal(
    needsRelationshipContext({
      type: "quoted",
      postId: "2",
      url: "https://x.com/i/web/status/2",
      text: "https://t.co/quoted",
    }),
    true,
  );
  assert.equal(
    needsRelationshipContext({
      type: "replied_to",
      postId: "3",
      url: "https://x.com/i/web/status/3",
    }),
    true,
  );
  assert.equal(
    needsRelationshipContext({
      type: "quoted",
      postId: "4",
      url: "https://x.com/i/web/status/4",
      text: "A substantive quoted post",
    }),
    false,
  );
});

test("reports actionable source gaps without treating ordinary model uncertainty as a gap", () => {
  const candidate = post("Read this thread 🧵", [
    {
      type: "replied_to",
      postId: "2",
      url: "https://x.com/i/web/status/2",
    },
  ]);
  candidate.fragments.push(
    { kind: "link", source: "post", url: "https://example.com/article" },
    {
      kind: "media",
      mediaKey: "3_image",
      mediaType: "image",
      role: "attachment",
      extraction: {
        kind: "screenshot",
        language: "en",
        verbatimText: "Readable text",
        visualSummary: "A readable screenshot.",
        keyFacts: [],
        uncertainties: ["The exact font is unknown."],
        model: "test/model",
      },
    },
  );
  assert.deepEqual(
    sourceGapsForPost(candidate).map(({ kind }) => kind),
    [
      "missing_referenced_context",
      "thread_marker_without_continuation",
      "unexpanded_external_links",
      "synthesis_pending",
    ],
  );
});
