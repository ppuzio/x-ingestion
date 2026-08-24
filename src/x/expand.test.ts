import assert from "node:assert/strict";
import test from "node:test";

import type { SavedPost } from "../model.ts";
import { externalUrlsForPost, shouldExpandThread } from "./expand.ts";

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
