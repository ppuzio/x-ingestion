import { resolve } from "node:path";

import {
  captureContextForPost,
  captureThreadForPost,
} from "../x/expand.ts";
import { latestSnapshots, loadSnapshots } from "../x/snapshots.ts";
import { parseArgument, requiredEnvironmentVariable, runMain } from "./util.ts";

async function main(): Promise<void> {
  const postId = parseArgument(process.argv, "post");
  if (!postId) throw new Error("Pass the saved thread opener as --post=<X post ID>");
  const contextId = parseArgument(process.argv, "context");
  const post = (await loadSnapshots(await latestSnapshots())).find(
    ({ id }) => id === postId,
  );
  if (!post) throw new Error(`Saved post ${postId} was not found`);
  const bearerToken =
    process.env.X_ARCHIVE_BEARER_TOKEN?.trim() ||
    requiredEnvironmentVariable("X_BEARER_TOKEN");
  const directory = resolve("data/raw");
  if (contextId) {
    const result = await captureContextForPost(post, contextId, bearerToken, directory);
    console.log(
      result.status === "captured"
        ? `Saved provided context post ${contextId} to ${result.path}`
        : `Context post ${contextId} was already captured`,
    );
    return;
  }
  const result = await captureThreadForPost(post, bearerToken, directory);
  console.log(
    result.status === "captured"
      ? `Saved ${result.count ?? 0} same-author window posts to ${result.path}`
      : `Thread for ${postId} was already captured`,
  );
}

runMain(main);
