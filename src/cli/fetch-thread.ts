import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { fetchConversationRaw, fetchPostRaw } from "../x/client.ts";
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
  const timestamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  const directory = resolve("data/raw");
  if (contextId) {
    const body = await fetchPostRaw(bearerToken, contextId);
    const path = resolve(directory, `context-${post.id}-${contextId}-${timestamp}.json`);
    await mkdir(directory, { recursive: true });
    await writeFile(path, body, { encoding: "utf8", flag: "wx" });
    console.log(`Saved provided context post ${contextId} to ${path}`);
    return;
  }
  if (!post.author.username) throw new Error(`Post ${postId} has no captured username`);
  if (!post.createdAt) throw new Error(`Post ${postId} has no captured creation time`);

  const body = await fetchConversationRaw({
    bearerToken,
    conversationId: post.conversationId ?? post.id,
    username: post.author.username,
    createdAt: post.createdAt,
  });
  const path = resolve(directory, `thread-${post.id}-${timestamp}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, body, { encoding: "utf8", flag: "wx" });
  const response = JSON.parse(body) as { data?: unknown };
  const count = Array.isArray(response.data) ? response.data.length : 0;
  console.log(`Saved ${count} same-author window posts to ${path}`);
}

runMain(main);
