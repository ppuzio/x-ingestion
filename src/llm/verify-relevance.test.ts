import assert from "node:assert/strict";
import test from "node:test";

import { parseUrlCitations } from "./openrouter.ts";
import {
  parseRelevanceVerification,
  protectBroadReplacement,
  protectIncompleteThread,
  protectVerification,
  requireVerificationEvidence,
} from "./verify-relevance.ts";

test("validates verification and requires citations for factual verdicts", () => {
  const verification = parseRelevanceVerification(
    {
      postId: "1",
      verdict: "current",
      reason: "The current specification retains this behavior.",
      currentGuidance: "The saved explanation remains useful.",
      evidenceUrls: ["https://example.com/spec"],
    },
    "1",
  );
  const citations = parseUrlCitations([
    {
      type: "url_citation",
      url_citation: { url: "https://example.com/spec", title: "Specification" },
    },
    {
      type: "url_citation",
      url_citation: { url: "https://example.com/spec", title: "Duplicate" },
    },
  ]);
  assert.deepEqual(citations, [
    { url: "https://example.com/spec", title: "Duplicate" },
  ]);
  assert.doesNotThrow(() => requireVerificationEvidence(verification, citations));
  assert.throws(() => requireVerificationEvidence(verification, []));
});

test("allows an opinion verdict without manufactured evidence", () => {
  const verification = parseRelevanceVerification(
    {
      postId: "1",
      verdict: "opinion",
      reason: "This is a testing-style preference.",
      currentGuidance: "Keep it as an opinion, not a freshness claim.",
      evidenceUrls: [],
    },
    "1",
  );
  assert.doesNotThrow(() => requireVerificationEvidence(verification, []));
});

test("does not invent a verdict from an incomplete thread", () => {
  const verification = protectIncompleteThread(
    {
      fragments: [
        { kind: "text", source: "post", text: "Performance thread, an example. 1/10" },
      ],
    } as never,
    {
      postId: "1",
      verdict: "partly_current",
      reason: "Generic guidance changed.",
      currentGuidance: "Use a different loop.",
      evidenceUrls: ["https://example.com"],
    },
  );
  assert.equal(verification.verdict, "unclear");
  assert.deepEqual(verification.evidenceUrls, []);
});

test("keeps unqualified replacement advice from becoming universally current", () => {
  const verification = protectBroadReplacement(
    {
      fragments: [
        { kind: "text", source: "post", text: "Still using join? Use Intl.ListFormat instead." },
      ],
    } as never,
    {
      postId: "1",
      verdict: "current",
      reason: "The replacement works for localized lists.",
      currentGuidance: "Use it for localized lists; join remains valid elsewhere.",
      evidenceUrls: ["https://example.com"],
    },
  );
  assert.equal(verification.verdict, "partly_current");
});

test("applies current ESLint evidence to return-await guidance", () => {
  const verification = protectVerification(
    {
      fragments: [
        { kind: "text", source: "post", text: "return await promise is the same as return promise" },
      ],
    } as never,
    {
      postId: "1",
      verdict: "current",
      reason: "They are equivalent.",
      currentGuidance: "Avoid return await.",
      evidenceUrls: ["https://example.com"],
    },
    [
      {
        url: "https://eslint.org/docs/latest/rules/no-return-await",
        content: "This rule was deprecated because it is no longer necessary.",
      },
    ],
  );
  assert.equal(verification.verdict, "partly_current");
  assert.match(verification.currentGuidance, /deprecated/);
});
