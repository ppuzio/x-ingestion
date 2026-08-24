import { captureLinksForPost } from "../x/expand.ts";
import { latestSnapshots, loadSnapshots } from "../x/snapshots.ts";
import { parseArgument, runMain } from "./util.ts";

async function main(): Promise<void> {
  const postId = parseArgument(process.argv, "post");
  if (!postId) throw new Error("Pass one saved post as --post=<X post ID>");
  const post = (await loadSnapshots(await latestSnapshots())).find(
    ({ id }) => id === postId,
  );
  if (!post) throw new Error(`Saved post ${postId} was not found`);
  const result = await captureLinksForPost(post, "data/raw");
  if (!result.captured && !result.skipped && !result.failures.length) {
    throw new Error(`Post ${postId} has no captured external links`);
  }
  if (result.failures.length) {
    throw new Error(`External link capture failed:\n${result.failures.join("\n")}`);
  }
  console.log(
    `Captured ${result.captured} external link(s); skipped ${result.skipped} already captured or capped`,
  );
}

runMain(main);
