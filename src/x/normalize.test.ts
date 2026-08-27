import assert from "node:assert/strict";
import test from "node:test";

import { shouldArchiveVideo } from "../model.ts";
import type { ArticleFragment, MediaFragment, TextFragment } from "../model.ts";
import { synthesisSource } from "../llm/enrich-post.ts";
import {
  canonicalizeTopic,
  normalizeTopicCase,
  renderObsidianNote,
} from "../obsidian/render.ts";
import {
  mergeSavedPosts,
  hasUsableContextPost,
  mergeRelationshipContext,
  normalizeContextResponse,
  normalizeLikesResponse,
  normalizeThreadResponse,
} from "./normalize.ts";

test("normalizes an exact provided context post with expanded links", () => {
  const context = normalizeContextResponse({
    data: {
      id: "2",
      author_id: "20",
      text: "resource https://t.co/example",
      article: { title: "Context article", plain_text: "Context article body" },
      entities: {
        urls: [{ expanded_url: "https://example.com/resource", title: "Resource" }],
      },
    },
    includes: { users: [{ id: "20", username: "author" }] },
  });
  assert.equal(context.type, "provided_context");
  assert.equal(context.article?.text, "Context article body");
  assert.equal(context.url, "https://x.com/author/status/2");
  assert.deepEqual(context.links, [
    {
      kind: "link",
      source: "post",
      url: "https://example.com/resource",
      title: "Resource",
    },
  ]);
});

test("recognizes deleted or withheld context responses without treating them as posts", () => {
  assert.equal(hasUsableContextPost({ errors: [{ title: "Not Found Error" }] }), false);
  assert.equal(hasUsableContextPost({ data: { id: "2", author_id: "20" } }), true);
});

test("merges fetched context into an existing relationship without duplicating it", () => {
  const merged = mergeRelationshipContext(
    {
      type: "quoted",
      postId: "2",
      url: "https://x.com/i/web/status/2",
      text: "https://t.co/quoted",
    },
    {
      type: "provided_context",
      postId: "2",
      url: "https://x.com/author/status/2",
      text: "https://t.co/quoted",
      article: {
        kind: "article",
        title: "Quoted article",
        text: "Article body",
        codeBlocks: [],
        mediaKeys: [],
      },
    },
  );
  assert.equal(merged.type, "quoted");
  assert.equal(merged.url, "https://x.com/author/status/2");
  assert.equal(merged.article?.text, "Article body");
});

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
      posts: [{
        id: "30",
        text: "Quoted text",
        author_id: "40",
        lang: "en",
        article: { title: "Quoted article", plain_text: "Quoted article body" },
      }],
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
  assert.equal(post.relationships[0]?.article?.text, "Quoted article body");
  const bookmarked = normalizeLikesResponse(
    raw,
    "data/raw/bookmarks-fixture.json",
    "2026-01-02T00:00:00Z",
    "bookmark",
  )[0];
  assert(bookmarked);
  const [merged] = mergeSavedPosts([post, bookmarked]);
  assert.deepEqual(merged?.captureMethods, ["like", "bookmark"]);
  assert.equal(merged?.rawSources.length, 2);
  post.enrichment = {
    summary: "A concise synthesis.",
    topics: ["Developer tools", "code quality", "code maintenance"],
    concepts: [
      "Context Engineering",
      "context engineering",
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
  assert.match(note.markdown, /\[\[context engineering\]\]/);
  assert.equal(note.markdown.match(/\[\[context engineering\]\]/g)?.length, 1);
  assert.match(note.markdown, /Article body/);
  assert.match(note.markdown, /Quoted article body/);

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

test("escapes HTML-like source text outside extracted code fences", () => {
  const note = renderObsidianNote({
    id: "html",
    url: "https://x.com/author/status/html",
    capturedAt: "2026-01-02T00:00:00Z",
    author: { id: "20", username: "author" },
    fragments: [
      { kind: "text", source: "post", text: "Use <button>" },
      {
        kind: "media",
        mediaKey: "3_image",
        mediaType: "image",
        role: "attachment",
        url: "https://img.test/button.jpg",
        altText: "<button> example",
        extraction: {
          kind: "screenshot",
          language: "JavaScript",
          verbatimText: "<button />",
          visualSummary: "A <button> element",
          keyFacts: ["The <button> receives clicks."],
          uncertainties: [],
          model: "test/model",
        },
      },
    ],
    relationships: [],
    captureMethods: ["like"],
    rawSources: [],
  });
  const beforeCodeFence = note.markdown.split("#### Extracted text")[0]!;
  assert.match(beforeCodeFence, /&lt;button&gt;/);
  assert.doesNotMatch(beforeCodeFence, /<button>/);
  assert.match(note.markdown, /```text\n<button \/>\n```/);
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

test("normalizes vocabulary labels to lowercase", () => {
  assert.equal(normalizeTopicCase("Artificial Intelligence"), "artificial intelligence");
  assert.equal(normalizeTopicCase("AI Agents"), "ai agents");
  assert.equal(normalizeTopicCase("AI-Assisted Development"), "ai-assisted development");
  assert.equal(normalizeTopicCase("CI/CD Automation"), "ci/cd automation");
  assert.equal(
    canonicalizeTopic("ai code assistants", {
      "AI code assistants": "AI coding assistants",
    }),
    "ai coding assistants",
  );
});

test("rejects a post id that could escape the preview directory", () => {
  assert.throws(
    () =>
      normalizeLikesResponse(
        {
          data: [{ id: "../../../tmp/evil", text: "hi", author_id: "20" }],
          includes: { users: [{ id: "20", username: "author" }] },
        },
        "data/raw/fixture.json",
        "2026-01-02T00:00:00Z",
      ),
    /Unsafe X post id/,
  );
});

test("drops media whose key could escape the attachments directory", () => {
  const [post] = normalizeLikesResponse(
    {
      data: [
        {
          id: "10",
          text: "hi",
          author_id: "20",
          attachments: { media_keys: ["../../escape", "3_image"] },
        },
      ],
      includes: {
        users: [{ id: "20", username: "author" }],
        media: [
          { media_key: "../../escape", type: "photo", url: "https://img.test/a.jpg" },
          { media_key: "3_image", type: "photo", url: "https://img.test/b.jpg" },
        ],
      },
    },
    "data/raw/fixture.json",
    "2026-01-02T00:00:00Z",
  );
  assert(post);
  assert.deepEqual(
    post.fragments
      .filter((fragment): fragment is MediaFragment => fragment.kind === "media")
      .map((fragment) => fragment.mediaKey),
    ["3_image"],
  );
});

test("keeps a multi-line article title on one line in the note and filename", () => {
  const [post] = normalizeLikesResponse(
    {
      data: [
        {
          id: "10",
          text: "https://t.co/article",
          author_id: "20",
          article: {
            title: "Line one\nline two",
            plain_text: "Body",
          },
        },
      ],
      includes: { users: [{ id: "20", username: "author" }] },
    },
    "data/raw/fixture.json",
    "2026-01-02T00:00:00Z",
  );
  assert(post);

  const note = renderObsidianNote(post);
  assert.equal(note.title, "Line one line two");
  assert.equal(note.filename, "Line_one_line_two--10.md");
  assert.doesNotMatch(note.filename, /\s/);
  assert.match(note.markdown, /\n# Line one line two\n/);
});

test("removes apostrophes from link-safe note filenames", () => {
  const [post] = normalizeLikesResponse(
    {
      data: [
        {
          id: "12",
          text: "Author's `guide` (quick)",
          author_id: "20",
        },
      ],
      includes: { users: [{ id: "20", username: "author" }] },
    },
    "data/raw/fixture.json",
    "2026-01-02T00:00:00Z",
  );
  assert(post);

  const note = renderObsidianNote(post);
  assert.equal(note.title, "Author's `guide` (quick)");
  assert.equal(note.filename, "Authors_guide_quick--12.md");
  assert.doesNotMatch(note.filename, /[^\p{L}\p{N}_.-]/u);
});

test("renders a captured external page as source material", () => {
  const note = renderObsidianNote({
    id: "11",
    url: "https://x.com/author/status/11",
    capturedAt: "2026-01-02T00:00:00Z",
    author: { id: "20", username: "author" },
    fragments: [
      { kind: "text", source: "post", text: "Read this" },
      {
        kind: "web_page",
        sourceUrl: "https://example.com/article",
        url: "https://example.com/article",
        contentType: "text/html",
        title: "External article",
        text: "Full captured article text.",
        capturedAt: "2026-01-02T00:00:00Z",
        rawPath: "data/raw/web/11/page.html",
      },
    ],
    relationships: [],
    relevance: {
      verdict: "partly_current",
      reason: "The core idea remains useful with one qualification.",
      currentGuidance: "Apply the qualification.",
      evidenceUrls: ["https://example.com/evidence"],
    },
    captureMethods: ["like"],
    rawSources: [],
  });
  assert.equal(note.title, "External article");
  assert.match(note.markdown, /## Linked page: External article/);
  assert.match(note.markdown, /Full captured article text\./);
  assert.match(note.markdown, /## Freshness/);
  assert.match(note.markdown, /relevance_status: "partly_current"/);
});

test("keeps only the focal author's reachable thread continuation", () => {
  const focal = {
    id: "1",
    author: { id: "20", username: "author" },
  } as never;
  const relationships = normalizeThreadResponse(
    {
      data: [
        {
          id: "3",
          author_id: "20",
          text: "third",
          created_at: "2022-01-01T00:02:00Z",
          referenced_posts: [{ id: "2", type: "replied_to" }],
        },
        {
          id: "4",
          author_id: "20",
          text: "side reply",
          created_at: "2022-01-01T00:04:00Z",
          referenced_posts: [{ id: "99", type: "replied_to" }],
        },
        {
          id: "2",
          author_id: "20",
          text: "second",
          entities: {
            urls: [{ expanded_url: "https://example.com/thread-resource" }],
          },
          created_at: "2022-01-01T00:02:00Z",
          referenced_posts: [{ id: "1", type: "replied_to" }],
        },
        {
          id: "5",
          author_id: "30",
          text: "someone else",
          created_at: "2022-01-01T00:05:00Z",
          referenced_posts: [{ id: "3", type: "replied_to" }],
        },
      ],
      includes: { users: [{ id: "20", username: "author" }] },
    },
    focal,
  );
  assert.deepEqual(relationships.map(({ postId }) => postId), ["2", "3"]);
  assert.deepEqual(relationships[0]?.links, [
    { kind: "link", source: "post", url: "https://example.com/thread-resource" },
  ]);
});
