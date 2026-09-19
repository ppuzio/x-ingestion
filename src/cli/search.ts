import { loadLatestPosts, searchPosts } from "../query.ts";
import { parseLimitArgument, runMain } from "./util.ts";

function searchArguments(argv: string[]): { query: string; limit: number } {
  const flags = argv.filter((argument) => argument.startsWith("--"));
  if (flags.some((argument) => !argument.startsWith("--limit=")) || flags.length > 1) {
    throw new Error('Usage: npm run search -- "query" [--limit=40]');
  }
  const query = argv.filter((argument) => !argument.startsWith("--")).join(" ").trim();
  if (!query) throw new Error('Usage: npm run search -- "query" [--limit=40]');
  const requestedLimit = parseLimitArgument(argv);
  return { query, limit: Number.isFinite(requestedLimit) ? requestedLimit : 40 };
}

async function main(): Promise<void> {
  const { query, limit } = searchArguments(process.argv.slice(2));
  console.log(JSON.stringify(searchPosts(await loadLatestPosts(), query, limit), null, 2));
}

runMain(main);
