import assert from "node:assert/strict";
import test from "node:test";

import type { SavedPost } from "../model.ts";
import {
  oldestFirst,
  parseRelevanceAssessments,
  protectMissingContext,
  protectOldEvolvingClaims,
} from "./triage-relevance.ts";

test("validates relevance triage IDs and web-check invariants", () => {
  const [assessment] = parseRelevanceAssessments(
    {
      assessments: [
        {
          postId: "1",
          status: "time_sensitive",
          reason: "The post recommends a versioned API.",
          needsWebCheck: true,
          webQuery: "current API documentation",
        },
      ],
    },
    ["1"],
  );
  assert.equal(assessment?.status, "time_sensitive");
  assert.throws(() =>
    parseRelevanceAssessments(
      {
        assessments: [
          {
            postId: "1",
            status: "durable",
            reason: "Stable advice.",
            needsWebCheck: true,
            webQuery: "unnecessary query",
          },
        ],
      },
      ["1"],
    ),
  );
});

test("triages oldest dated posts first and undated posts last", () => {
  const posts = [
    { id: "new", createdAt: "2026-01-01T00:00:00Z" },
    { id: "unknown" },
    { id: "old", createdAt: "2024-01-01T00:00:00Z" },
  ] as SavedPost[];
  assert.deepEqual(oldestFirst(posts).map(({ id }) => id), [
    "old",
    "new",
    "unknown",
  ]);
});

test("does not discard knowledge that may be inside unprocessed media", () => {
  const posts = [
    {
      id: "1",
      fragments: [
        { kind: "media", role: "attachment", mediaKey: "3_1", mediaType: "image" },
      ],
    },
  ] as SavedPost[];
  const [assessment] = protectMissingContext(posts, [
    {
      postId: "1",
      status: "non_knowledge",
      reason: "No useful text.",
      needsWebCheck: false,
      webQuery: null,
    },
  ]);
  assert.equal(assessment?.status, "unclear");
});

test("does not make already-useful text unclear merely because media is attached", () => {
  const posts = [
    {
      id: "1",
      fragments: [
        { kind: "text", source: "post", text: "A useful CSS technique." },
        { kind: "media", role: "attachment", mediaKey: "3_1", mediaType: "image" },
      ],
    },
  ] as SavedPost[];
  const [assessment] = protectMissingContext(posts, [
    {
      postId: "1",
      status: "durable",
      reason: "The post explains a durable technique.",
      needsWebCheck: false,
      webQuery: null,
    },
  ]);
  assert.equal(assessment?.status, "durable");
});

test("forces old comparative runtime claims into web verification", () => {
  const posts = [
    {
      id: "1",
      createdAt: "2022-01-01T00:00:00Z",
      fragments: [
        {
          kind: "text",
          source: "post",
          text: "return await promise is the same as return promise",
        },
      ],
    },
  ] as SavedPost[];
  const [assessment] = protectOldEvolvingClaims(
    posts,
    [
      {
        postId: "1",
        status: "durable",
        reason: "A language fact.",
        needsWebCheck: false,
        webQuery: null,
      },
    ],
    "2026-08-18",
  );
  assert.equal(assessment?.status, "time_sensitive");
  assert.match(assessment?.webQuery ?? "", /2026/);
});
