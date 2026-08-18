import assert from "node:assert/strict";
import test from "node:test";

import { shouldArchiveVideo } from "../model.ts";
import type { ArticleFragment, MediaFragment, TextFragment } from "../model.ts";
import { synthesisSource } from "../llm/enrich-post.ts";
import { renderObsidianNote } from "../obsidian/render.ts";
import { normalizeLikesResponse } from "./normalize.ts";

test("normalizes mixed X content into replayable fragments and renders it", () => {
  const raw = {
    data: [
      {
        id: "10",
        text: "short text https://t.co/a",
        author_id: "20",
        created_at: "2026-01-01T00:00:00Z",
        lang: "zh",
        note_post: { text: "完整文本" },
        attachments: { media_keys: ["3_image", "13_video"] },
        entities: {
          urls: [
            {
              expanded_url: "https://example.com/article",
              title: "Example",
            },
          ],
        },
        article: {
          title: "Useful article",
          plain_text: "Article body",
          media_entities: ["3_cover"],
          cover_media: "3_cover",
          entities: { code: [{ code: "npm test", language: "bash" }] },
        },
        referenced_posts: [{ id: "30", type: "quoted" }],
      },
    ],
    includes: {
      users: [{ id: "20", username: "author", name: "Author" }],
      media: [
        { media_key: "3_image", type: "photo", url: "https://img.test/a.jpg" },
        { media_key: "3_cover", type: "photo", url: "https://img.test/b.jpg" },
        {
          media_key: "13_video",
          type: "video",
          duration_ms: 12_000,
          variants: [
            { content_type: "video/mp4", bit_rate: 8_000_000, url: "https://video.test/high.mp4" },
            { content_type: "video/mp4", bit_rate: 1_200_000, url: "https://video.test/medium.mp4" },
          ],
        },
      ],
      posts: [{ id: "30", text: "Quoted text", author_id: "40", lang: "en" }],
    },
  };

  const [post] = normalizeLikesResponse(
    raw,
    "data/raw/fixture.json",
    "2026-01-02T00:00:00Z",
  );
  assert(post);
  assert.equal(post.author.username, "author");
  assert.equal(
    post.fragments.find((fragment): fragment is TextFragment => fragment.kind === "text")
      ?.text,
    "完整文本",
  );
  assert.equal(
    post.fragments.find(
      (fragment): fragment is ArticleFragment => fragment.kind === "article",
    )?.codeBlocks[0]?.code,
    "npm test",
  );
  assert.deepEqual(
    post.fragments
      .filter((fragment): fragment is MediaFragment => fragment.kind === "media")
      .map(({ mediaKey, role }) => [mediaKey, role]),
    [
      ["3_image", "attachment"],
      ["13_video", "attachment"],
      ["3_cover", "article_cover"],
    ],
  );
  const video = post.fragments.find(
    (fragment): fragment is MediaFragment =>
      fragment.kind === "media" && fragment.mediaType === "video",
  );
  assert.equal(video?.url, "https://video.test/medium.mp4");
  assert.equal(video?.durationMs, 12_000);
  if (video) {
    video.extraction = {
      kind: "screenshot",
      language: "en",
      verbatimText: "Useful extracted text",
      visualSummary: "Useful visual context",
      keyFacts: ["Useful visual fact"],
      uncertainties: ["Low-level uncertainty should not bias synthesis"],
      model: "test/model",
    };
  }
  assert.match(synthesisSource(post), /Useful visual fact/);
  assert.doesNotMatch(synthesisSource(post), /Low-level uncertainty/);
  assert.equal(post.relationships[0]?.text, "Quoted text");
  post.enrichment = {
    summary: "A concise synthesis.",
    topics: ["Developer tools", "code quality", "code maintenance"],
    concepts: [
      "Context Engineering",
      "task boundary definition",
      "turning grilling sessions into shareable questionnaires",
    ],
    technologies: ["TypeScript"],
    people: ["Example Person"],
    claims: ["The source claims the tool is faster."],
    relevance: "Useful for evaluating developer workflows.",
    model: "test/model",
    promptVersion: "v4",
  };

  const note = renderObsidianNote(post);
  assert.match(note.markdown, /# Useful article/);
  assert.match(note.markdown, /needs_translation: true/);
  assert.match(note.markdown, /needs_vision: true/);
  assert.match(note.markdown, /needs_synthesis: false/);
  assert.match(note.markdown, /\[\[Context Engineering\]\]/);
  assert.match(note.markdown, /Article body/);

  const normalizedNote = renderObsidianNote(post, {
    aliases: {
      topic: { "code maintenance": "code quality" },
      concept: { "task boundary definition": "task decomposition" },
    },
    plainText: {
      concept: ["turning grilling sessions into shareable questionnaires"],
    },
  }).markdown;
  assert.equal(normalizedNote.match(/  - "code quality"/g)?.length, 1);
  assert.match(normalizedNote, /\[\[task decomposition\]\]/);
  assert.match(normalizedNote, /- turning grilling sessions into shareable questionnaires/);
  assert.doesNotMatch(
    normalizedNote,
    /\[\[turning grilling sessions into shareable questionnaires\]\]/,
  );
  assert.ok(post.enrichment.concepts.includes("task boundary definition"));
});

test("keeps zxx as source metadata instead of treating an article as zxx", () => {
  const [post] = normalizeLikesResponse(
    {
      data: [
        {
          id: "10",
          text: "https://t.co/article",
          author_id: "20",
          lang: "zxx",
          article: { title: "English article", plain_text: "An English body." },
        },
      ],
      includes: { users: [{ id: "20", username: "author" }] },
    },
    "data/raw/fixture.json",
    "2026-01-02T00:00:00Z",
  );
  assert(post);

  const note = renderObsidianNote(post).markdown;
  assert.match(note, /source_language: "zxx"/);
  assert.doesNotMatch(note, /\nlanguage: "zxx"/);
  assert.match(note, /## Source post \(no linguistic content\)/);
});

test("archives only videos up to ten minutes", () => {
  assert.equal(shouldArchiveVideo(10 * 60 * 1_000), true);
  assert.equal(shouldArchiveVideo(10 * 60 * 1_000 + 1), false);
});
