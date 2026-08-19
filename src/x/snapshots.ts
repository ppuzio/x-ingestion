import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { CaptureMethod, SavedPost } from "../model.ts";
import { webPageFragment } from "../web/page.ts";
import {
  mergeSavedPosts,
  normalizeContextResponse,
  normalizeLikesResponse,
  normalizeThreadResponse,
} from "./normalize.ts";

export const snapshotPattern = /^(likes|bookmarks)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:-page-\d{3})?\.json$/;

export async function latestSnapshots(directory = resolve("data/raw")): Promise<string[]> {
  const snapshots = (await readdir(directory)).flatMap((name) => {
    const match = name.match(snapshotPattern);
    return match ? [{ name, collection: match[1]!, timestamp: match[2]! }] : [];
  });
  const latestByCollection = new Map<string, string>();
  for (const { collection, timestamp } of snapshots) {
    if (timestamp > (latestByCollection.get(collection) ?? "")) {
      latestByCollection.set(collection, timestamp);
    }
  }
  if (!latestByCollection.size) throw new Error("No raw X snapshots found in data/raw");
  return snapshots
    .filter(({ collection, timestamp }) => timestamp === latestByCollection.get(collection))
    .sort(
      (a, b) =>
        Number(b.collection === "likes") - Number(a.collection === "likes") ||
        a.name.localeCompare(b.name),
    )
    .map(({ name }) => resolve(directory, name));
}

export function snapshotTimestamp(path: string): string | undefined {
  return basename(path).match(snapshotPattern)?.[2];
}

function capturedAt(path: string): string {
  const timestamp = snapshotTimestamp(path);
  return timestamp
    ? `${timestamp.slice(0, 10)}T${timestamp.slice(11).replaceAll("-", ":")}Z`
    : new Date().toISOString();
}

function captureMethod(path: string): CaptureMethod {
  return basename(path).startsWith("bookmarks-") ? "bookmark" : "like";
}

export async function loadSnapshots(paths: string[]): Promise<SavedPost[]> {
  const posts = mergeSavedPosts(
    (
      await Promise.all(
        paths.map(async (path) =>
          normalizeLikesResponse(
            JSON.parse(await readFile(path, "utf8")) as unknown,
            path,
            capturedAt(path),
            captureMethod(path),
          ),
        ),
      )
    ).flat(),
  );
  const directory = resolve("data/raw");
  const names = await readdir(directory);
  for (const post of posts) {
    const prefix = `thread-${post.id}-`;
    const latest = names.filter((name) => name.startsWith(prefix)).sort().at(-1);
    if (!latest) continue;
    const response = JSON.parse(await readFile(resolve(directory, latest), "utf8"));
    post.relationships.push(...normalizeThreadResponse(response, post));
  }
  for (const post of posts) {
    const prefix = `context-${post.id}-`;
    const latestByContext = new Map<string, string>();
    for (const name of names.filter((candidate) => candidate.startsWith(prefix)).sort()) {
      const contextId = name.slice(prefix.length).split("-", 1)[0];
      if (contextId) latestByContext.set(contextId, name);
    }
    for (const name of latestByContext.values()) {
      const response = JSON.parse(await readFile(resolve(directory, name), "utf8"));
      post.relationships.push(normalizeContextResponse(response));
    }
  }
  for (const post of posts) {
    const webRoot = resolve("data/raw/web", post.id);
    let captures: string[];
    try {
      captures = await readdir(webRoot);
    } catch {
      continue;
    }
    const latestByUrl = new Map<string, string>();
    for (const name of captures.filter((candidate) => candidate.endsWith(".json")).sort()) {
      const hash = name.match(/^page-([a-f0-9]{12})-/)?.[1];
      if (hash) latestByUrl.set(hash, name);
    }
    for (const name of latestByUrl.values()) {
      const capture = JSON.parse(await readFile(resolve(webRoot, name), "utf8"));
      post.fragments.push(webPageFragment(capture));
    }
  }
  return posts;
}
