import { loadLatestPosts, readPost } from "../query.ts";
import { runMain } from "./util.ts";

function postIdArgument(argv: string[]): string {
  if (argv.length !== 1 || !/^\d+$/.test(argv[0] ?? "")) {
    throw new Error("Usage: npm run read-post -- <post-id>");
  }
  return argv[0]!;
}

async function main(): Promise<void> {
  const postId = postIdArgument(process.argv.slice(2));
  console.log(JSON.stringify(readPost(await loadLatestPosts(), postId), null, 2));
}

runMain(main);
