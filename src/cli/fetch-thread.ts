import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { fetchConversationRaw } from "../x/client.ts";
import { latestSnapshots, loadSnapshots } from "../x/snapshots.ts";
import { requiredEnvironmentVariable, runMain } from "./util.ts";

async function main(): Promise<void> {
  const postId = process.argv.find((value) => value.startsWith("--post="))
    ?.slice("--post=".length);
  if (!postId) throw new Error("Pass the saved thread opener as --post=<X post ID>");
  const post = (await loadSnapshots(await latestSnapshots())).find(
    ({ id }) => id === postId,
  );
  if (!post) throw new Error(`Saved post ${postId} was not found`);
  if (!post.author.username) throw new Error(`Post ${postId} has no captured username`);
  if (!post.createdAt) throw new Error(`Post ${postId} has no captured creation time`);

  const body = await fetchConversationRaw({
    bearerToken:
      process.env.X_ARCHIVE_BEARER_TOKEN?.trim() ||
      requiredEnvironmentVariable("X_BEARER_TOKEN"),
    conversationId: post.conversationId ?? post.id,
    username: post.author.username,
    createdAt: post.createdAt,
  });
  const timestamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  const directory = resolve("data/raw");
  const path = resolve(directory, `thread-${post.id}-${timestamp}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, body, { encoding: "utf8", flag: "wx" });
  const response = JSON.parse(body) as { data?: unknown };
  const count = Array.isArray(response.data) ? response.data.length : 0;
  console.log(`Saved ${count} same-author window posts to ${path}`);
}

runMain(main);
