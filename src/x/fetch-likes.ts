import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { fetchUserPostsRaw, type XCollection } from "./client.ts";

/**
 * A routine incremental run usually finds only a few new saves, so the first
 * request asks for a small page; later pages use the API maximum of 100.
 */
const INCREMENTAL_FIRST_PAGE_SIZE = 10;

export interface FetchAndSaveCollectionOptions {
  bearerToken: string;
  userId: string;
  collection: XCollection;
  maxPosts?: number;
  /** IDs already captured for this collection; paging stops at a page with none unseen. */
  knownIds?: ReadonlySet<string>;
  now?: Date;
  outputDirectory?: string;
}

export async function fetchAndSaveCollection({
  bearerToken,
  userId,
  collection,
  maxPosts = 1_000,
  knownIds,
  now = new Date(),
  outputDirectory = resolve("data/raw"),
}: FetchAndSaveCollectionOptions): Promise<{
  paths: string[];
  postCount: number;
  reachedKnown: boolean;
}> {
  if (!Number.isInteger(maxPosts) || maxPosts < 5 || maxPosts > 1_000) {
    throw new Error("maxPosts must be an integer from 5 to 1000");
  }

  const timestamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  await mkdir(outputDirectory, { recursive: true });

  const paths: string[] = [];
  const seenTokens = new Set<string>();
  let paginationToken: string | undefined;
  let postCount = 0;
  while (postCount < maxPosts) {
    const body = await fetchUserPostsRaw({
      bearerToken,
      userId,
      collection,
      maxResults: Math.min(
        paths.length === 0 && knownIds?.size ? INCREMENTAL_FIRST_PAGE_SIZE : 100,
        Math.max(collection === "likes" ? 5 : 1, maxPosts - postCount),
      ),
      ...(paginationToken ? { paginationToken } : {}),
    });
    const page = paths.length + 1;
    const outputPath = resolve(
      outputDirectory,
      `${collection}-${timestamp}-page-${String(page).padStart(3, "0")}.json`,
    );
    await writeFile(outputPath, body, { encoding: "utf8", flag: "wx" });
    paths.push(outputPath);

    const response = JSON.parse(body) as {
      data?: unknown;
      meta?: { next_token?: unknown };
    };
    if (response.data !== undefined && !Array.isArray(response.data)) {
      throw new Error(`X ${collection} response data must be an array`);
    }
    const ids = (Array.isArray(response.data) ? response.data : []).map(
      (post) => (post as { id?: unknown }).id,
    );
    postCount += ids.length;
    // X returns newest saves first, so a page of only known posts means the
    // rest of the collection was captured by an earlier run.
    if (knownIds && ids.length && ids.every((id) => typeof id === "string" && knownIds.has(id))) {
      return { paths, postCount, reachedKnown: true };
    }
    const nextToken = response.meta?.next_token;
    if (typeof nextToken !== "string") break;
    if (seenTokens.has(nextToken)) {
      throw new Error(`X ${collection} pagination repeated a token`);
    }
    seenTokens.add(nextToken);
    paginationToken = nextToken;
  }

  return { paths, postCount, reachedKnown: false };
}
