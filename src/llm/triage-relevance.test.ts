import assert from "node:assert/strict";
import test from "node:test";

import { parseRelevanceAssessments } from "./triage-relevance.ts";

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
