import { loadLatestPosts, searchPosts } from "../query.ts";
import { runMain } from "./util.ts";

// Real user questions: expected IDs are public; private capture text stays local.
const cases = [
  { query: "Obsidian reasoning citation retrieval", expected: ["2098433272573214816"] },
  {
    query: "organizational second brain recipes knowledge corrections",
    expected: ["2095482394513924178"],
  },
  {
    query: "Obsidian agents knowledge recipes",
    expected: ["2098433272573214816", "2095482394513924178"],
  },
  {
    query: "How can I connect an AI assistant to my Obsidian vault and check that its answers cite my notes?",
    expected: ["2098433272573214816"],
  },
  {
    query: "What did I save about testing whether a model can find old details in my notes and choosing reasoning effort for synthesis?",
    expected: ["2098433272573214816"],
  },
  {
    query: "How does Meta separate organizational knowledge from recipes and learn from expert corrections without retraining?",
    expected: ["2095482394513924178"],
  },
  {
    query: "Find the post about deciding whether an agent failure comes from missing knowledge or a broken procedure.",
    expected: ["2095482394513924178"],
  },
  {
    query: "What lessons about Obsidian agents, knowledge, and recipes should we evaluate for a saved-post ingestion project? Separate source claims from project-specific suggestions.",
    expected: ["2098433272573214816", "2095482394513924178"],
  },
  {
    query: "Which saved ideas could help agents use my Obsidian notes more reliably, with evidence and reusable workflows?",
    expected: ["2098433272573214816", "2095482394513924178"],
  },
];

async function main(): Promise<void> {
  const posts = await loadLatestPosts();
  const results = cases.map(({ query, expected }) => {
    const ranked = searchPosts(posts, query, Math.max(posts.length, 1));
    const targets = expected.map((postId) => {
      const index = ranked.findIndex((card) => card.postId === postId);
      return { postId, rank: index < 0 ? null : index + 1 };
    });
    return { query, targets, allInAskDefault: targets.every(({ rank }) => rank !== null && rank <= 12), pass: targets.every(({ rank }) => rank !== null && rank <= 10) };
  });
  console.log(JSON.stringify({
    collectionSize: posts.length,
    cutoff: 10,
    passed: results.filter(({ pass }) => pass).length,
    total: results.length,
    results,
  }, null, 2));
  if (results.some(({ pass }) => !pass)) process.exitCode = 1;
}

runMain(main);
