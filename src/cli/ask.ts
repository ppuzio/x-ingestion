import { answerKnowledgeQuery } from "../llm/query.ts";
import { searchPosts, loadLatestPosts } from "../query.ts";
import {
  parseLimitArgument,
  requiredEnvironmentVariable,
  runMain,
} from "./util.ts";

function queryFromArguments(arguments_: string[]): string {
  const query = arguments_
    .filter((argument) => !argument.startsWith("--"))
    .join(" ")
    .trim();
  if (!query) throw new Error('Usage: npm run ask -- "your question" [--limit=80]');
  return query;
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const query = queryFromArguments(arguments_);
  const requestedLimit = parseLimitArgument(arguments_);
  const candidateLimit = Number.isFinite(requestedLimit) ? requestedLimit : 80;
  const posts = await loadLatestPosts();
  const cards = searchPosts(posts, query, candidateLimit);
  if (!cards.length) throw new Error("No canonical posts are available to query");

  const apiKey = requiredEnvironmentVariable("OPENROUTER_KEY");
  const model =
    process.env.OPENROUTER_QUERY_MODEL?.trim() ||
    process.env.OPENROUTER_SYNTHESIS_MODEL?.trim() ||
    "openai/gpt-5.6-luna";
  const { answer } = await answerKnowledgeQuery(apiKey, model, query, cards);
  const byId = new Map(cards.map((card) => [card.postId, card]));

  console.log(`# ${query}\n`);
  console.log(`${answer.overview}\n`);
  for (const idea of answer.ideas) {
    console.log(`## ${idea.name}\n`);
    console.log(`${idea.whatItIs}\n`);
    console.log(`Why it may help: ${idea.whyItMayHelp}\n`);
    console.log(`First experiment: ${idea.firstExperiment}\n`);
    console.log("Sources:");
    for (const postId of idea.sourcePostIds) {
      const card = byId.get(postId);
      if (card) console.log(`- [${postId}](${card.sourceUrl})`);
    }
    console.log();
  }
  if (answer.caveats.length) {
    console.log("## Caveats\n");
    answer.caveats.forEach((caveat) => console.log(`- ${caveat}`));
  }
}

runMain(main);
