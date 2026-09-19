import assert from "node:assert/strict";
import test from "node:test";

import type { SavedPost } from "./model.ts";
import { readPost, searchPosts } from "./query.ts";

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
  assert.equal(results[0]?.sourceNotePath, "Sources/x-2.md");
});

test("searchPosts rejects an empty query", () => {
  assert.throws(() => searchPosts([], "   "), /must not be empty/);
});

test("search and read expose evidence beyond the old 600-character boundary", () => {
  const lateEvidence = "evidence-after-six-hundred";
  const longText = `${"background ".repeat(70)}${lateEvidence}${" complete".repeat(80)}`;
  const candidate = post("42", longText, [], []);

  assert.match(searchPosts([candidate], lateEvidence)[0]?.sourceExcerpt ?? "", new RegExp(lateEvidence));
  assert.equal(
    (readPost([candidate], "42").fragments[0] as { text: string }).text,
    longText,
  );
});

test("readPost returns relationships, source gaps, and provenance without raw payloads", () => {
  const candidate = post("42", "A source post", [], []);
  candidate.relationships = [{
    type: "quoted",
    postId: "41",
    url: "https://x.com/example/status/41",
    text: "Quoted context",
  }, {
    type: "replied_to",
    postId: "40",
    url: "https://x.com/example/status/40",
  }];
  candidate.rawSources = [{
    method: "like",
    snapshot: "data/raw/likes.json",
    post: { very: "large duplicate payload" },
  }];

  const result = readPost([candidate], "42");
  assert.equal(result.relationships[0]?.text, "Quoted context");
  assert.deepEqual(result.provenance.rawSources, [{
    method: "like",
    snapshot: "data/raw/likes.json",
  }]);
  assert.equal("post" in result.provenance.rawSources[0]!, false);
  assert.equal(result.sourceGaps[0]?.kind, "missing_referenced_context");
  assert.ok(result.generatedMetadata.enrichment);
});

test("readPost rejects invalid and missing IDs", () => {
  assert.throws(() => readPost([], "not-an-id"), /only digits/);
  assert.throws(() => readPost([], "42"), /Post not found: 42/);
});

test("ranking prefers source evidence over metadata and avoids substring matches", () => {
  const direct = post("1", "Local backups restore encrypted archives", [], []);
  delete direct.enrichment;
  const generated = post("2", "A gardening article", [], ["Local backups restore encrypted archives"]);
  const substring = post("3", "The restoration was backed up", [], []);
  const results = searchPosts([generated, substring, direct], "restore archives");
  assert.equal(results[0]?.postId, "1");
  assert.equal(results.find(({ postId }) => postId === "3")?.score, 0);
});

test("ranking rewards distinctive terms without rewarding repetition", () => {
  const candidates = [post("1", "quartz", [], []), post("2", "ordinary ".repeat(100), [], [])];
  for (let id = 3; id < 10; id++) candidates.push(post(String(id), "ordinary", [], []));
  assert.equal(searchPosts(candidates, "ordinary quartz")[0]?.postId, "1");
  assert.equal(searchPosts(candidates, "ordinary").find(x => x.postId === "2")?.score,
    searchPosts(candidates, "ordinary").find(x => x.postId === "3")?.score);
});

test("evidence windows reach deep articles and referenced context within a fixed budget", () => {
  const candidate = post("1", "An introduction", [], []);
  candidate.fragments.push({ kind: "article", title: "Storage", text: "Background. ".repeat(700) + "quartz restore procedure", codeBlocks: [], mediaKeys: [] });
  candidate.relationships = [{ type: "quoted", postId: "2", url: "https://x.com/i/status/2", text: "quartz restore verification" }];
  const result = searchPosts([candidate], "quartz restore")[0]!;
  assert.ok(result.evidence?.some(({ location, text }) => location.includes("fragments[1]") && text.includes("quartz restore procedure")));
  assert.ok(result.evidence?.some(({ location, text }) => location.includes("relationships[0]") && text.includes("verification")));
  assert.ok(result.evidence!.length <= 3);
  assert.ok(result.evidence!.every(({ text }) => text.length <= 1000));
});
