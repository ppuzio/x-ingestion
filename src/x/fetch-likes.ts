import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { fetchLikedPostsRaw } from "./client.ts";

export interface FetchAndSaveLikesOptions {
  bearerToken: string;
  userId: string;
  maxResults?: number;
  now?: Date;
}

export async function fetchAndSaveLikes({
  bearerToken,
  userId,
  maxResults = 50,
  now = new Date(),
}: FetchAndSaveLikesOptions): Promise<string> {
  const body = await fetchLikedPostsRaw({ bearerToken, userId, maxResults });
  const outputDirectory = resolve("data/raw");
  const timestamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  const outputPath = resolve(outputDirectory, `likes-${timestamp}.json`);

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, body, { encoding: "utf8", flag: "wx" });

  return outputPath;
}
