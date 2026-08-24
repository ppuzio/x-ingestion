import assert from "node:assert/strict";
import test from "node:test";

import type { SavedPost } from "./model.ts";
import { searchPosts } from "./query.ts";

function post(
  id: string,
  text: string,
  technologies: string[],
  claims: string[],
): SavedPost {
  return {
    id,
    url: `https://x.com/example/status/${id}`,
    capturedAt: "2026-08-24T00:00:00Z",
    author: { id: "author", username: "example" },
    fragments: [{ kind: "text", source: "post", text }],
    relationships: [],
    captureMethods: ["like"],
    rawSources: [],
    enrichment: {
      summary: text,
      topics: ["developer productivity"],
      concepts: ["codebase workflow"],
      technologies,
      people: [],
      claims,
      relevance: "Useful for improving development work.",
      model: "test",
      promptVersion: "test",
    },
  };
}

test("searchPosts ranks enriched tool records and preserves provenance", () => {
  const results = searchPosts(
    [
      post("1", "A general note", ["Unrelated tool"], ["A note about cooking."]),
      post(
        "2",
        "A tool that makes a codebase faster",
        ["Graft"],
        ["Graft makes coding agents faster and cheaper."],
      ),
      post(
        "3",
        "A visual map for understanding a codebase",
        ["system-atlas"],
        ["The atlas helps explore complex codebases."],
      ),
    ],
    "codebase faster",
    2,
  );

  assert.deepEqual(results.map(({ postId }) => postId), ["2", "3"]);
  assert.equal(results[0]?.technologies[0], "Graft");
  assert.match(results[0]?.sourceExcerpt ?? "", /codebase faster/);
  assert.equal(results[0]?.sourceUrl, "https://x.com/example/status/2");
});

test("searchPosts rejects an empty query", () => {
  assert.throws(() => searchPosts([], "   "), /must not be empty/);
});
