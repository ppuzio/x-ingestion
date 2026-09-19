import assert from "node:assert/strict";
import test from "node:test";

import type { SearchCard } from "../query.ts";
import { parseKnowledgeAnswer } from "./query.ts";

function card(postId: string): SearchCard {
  return {
    postId,
    sourceUrl: `https://x.com/example/status/${postId}`,
    topics: [],
    concepts: [],
    technologies: [],
    people: [],
    claims: [],
    sourceExcerpt: "",
    score: 1,
  };
}

test("parseKnowledgeAnswer keeps valid citations and drops unknown ids", () => {
  const answer = parseKnowledgeAnswer(
    {
      overview: "A useful answer.",
      ideas: [
        {
          name: "Known tool",
          whatItIs: "A tool.",
          whyItMayHelp: "It may help.",
          firstExperiment: "Try it once.",
          sourcePostIds: ["known", "hallucinated"],
        },
      ],
      caveats: [],
    },
    [card("known")],
  );

  assert.deepEqual(answer.ideas[0]?.sourcePostIds, ["known"]);
  assert.match(answer.caveats[0] ?? "", /hallucinated/);
});

test("parseKnowledgeAnswer rejects answers with no supported idea sources", () => {
  assert.throws(
    () =>
      parseKnowledgeAnswer(
        {
          overview: "A useful answer.",
          ideas: [
            {
              name: "Unknown tool",
              whatItIs: "A tool.",
              whyItMayHelp: "It may help.",
              firstExperiment: "Try it once.",
              sourcePostIds: ["hallucinated"],
            },
          ],
          caveats: [],
        },
        [card("known")],
      ),
    /no ideas with valid source references/,
  );
});

test("an answer may abstain when candidate evidence is insufficient", () => {
  assert.deepEqual(parseKnowledgeAnswer({ overview: "Insufficient evidence.", ideas: [], caveats: ["No supporting passage."] }, [card("1")]).ideas, []);
});

test("answer request retains deep evidence and source gaps beyond compact excerpts", async () => {
  const { answerKnowledgeQuery } = await import("./query.ts");
  const originalFetch = globalThis.fetch;
  let sent = "";
  globalThis.fetch = async (_url, options) => {
    sent = String(options?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ overview: "Insufficient evidence.", ideas: [], caveats: [] }) } }] }), { status: 200 });
  };
  try {
    const candidate = card("1");
    candidate.evidence = [{ location: "fragments[1], chars 7000-8000", text: "a".repeat(800) + "DEEP_EVIDENCE" }];
    candidate.sourceGaps = [{ kind: "synthesis_pending", message: "Pending synthesis" }];
    await answerKnowledgeQuery("test", "test/model", "evidence", [candidate]);
    assert.ok(sent.includes("DEEP_EVIDENCE"));
    assert.ok(sent.includes("Pending synthesis"));
    assert.ok(sent.includes("7000-8000"));
  } finally { globalThis.fetch = originalFetch; }
});
