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
