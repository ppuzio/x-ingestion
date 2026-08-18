import assert from "node:assert/strict";
import test from "node:test";

import { parseUrlCitations } from "./openrouter.ts";
import {
  parseRelevanceVerification,
  requireVerificationEvidence,
} from "./verify-relevance.ts";

test("validates verification and requires citations for factual verdicts", () => {
  const verification = parseRelevanceVerification(
    {
      postId: "1",
      verdict: "current",
      reason: "The current specification retains this behavior.",
      currentGuidance: "The saved explanation remains useful.",
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
    },
    "1",
  );
  assert.doesNotThrow(() => requireVerificationEvidence(verification, []));
});
