import assert from "node:assert/strict";
import test from "node:test";

import type { SavedPost } from "../model.ts";
import {
  oldestFirst,
  parseRelevanceAssessments,
  protectMissingContext,
  protectOldEvolvingClaims,
  relevanceSource,
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

test("does not discard an incomplete post that signals useful advice or a technique", () => {
  const posts = [
    {
      id: "1",
      fragments: [
        { kind: "text", source: "post", text: "Here are ten interview questions with advice." },
      ],
    },
  ] as SavedPost[];
  const [assessment] = protectMissingContext(posts, [
    {
      postId: "1",
      status: "non_knowledge",
      reason: "Prescriptive social content.",
      needsWebCheck: false,
      webQuery: null,
    },
  ]);
  assert.equal(assessment?.status, "unclear");
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

test("labels the parent of a short reply as interpretation context", () => {
  const source = relevanceSource({
    id: "2",
    url: "https://x.com/author/status/2",
    capturedAt: "2026-01-01T00:00:00Z",
    author: { id: "20", username: "author" },
    fragments: [{ kind: "text", source: "post", text: "This is my day job" }],
    relationships: [
      {
        type: "replied_to",
        postId: "1",
        url: "https://x.com/i/web/status/1",
        text: "Which framework has the best accessibility support?",
      },
    ],
    captureMethods: ["like"],
    rawSources: [],
  });
  assert.match(source, /PARENT REPLY CONTEXT/);
  assert.match(source, /best accessibility support/);
});

test("routes an old short reply through verification when its parent asks about current tooling", () => {
  const posts = [
    {
      id: "2",
      createdAt: "2022-04-24T18:52:24Z",
      fragments: [{ kind: "text", source: "post", text: "This is my day job" }],
      relationships: [
        {
          type: "replied_to",
          postId: "1",
          text: "Which current JavaScript framework has the best accessibility support?",
        },
      ],
    },
  ] as SavedPost[];
  const [assessment] = protectOldEvolvingClaims(
    posts,
    [
      {
        postId: "2",
        status: "durable",
        reason: "A durable answer.",
        needsWebCheck: false,
        webQuery: null,
      },
    ],
    "2026-08-19",
  );
  assert.equal(assessment?.status, "time_sensitive");
  assert.match(assessment?.webQuery ?? "", /accessibility/);
});
