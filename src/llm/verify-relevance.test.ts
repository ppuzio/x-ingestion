import assert from "node:assert/strict";
import test from "node:test";

import { parseUrlCitations } from "./openrouter.ts";
import {
  parseRelevanceVerification,
  protectIncompleteThread,
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
