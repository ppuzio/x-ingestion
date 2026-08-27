import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { CaptureMethod, SavedPost } from "../model.ts";
import { readJson } from "../json.ts";
import { webPageFragment } from "../web/page.ts";
import {
  mergeSavedPosts,
  hasUsableContextPost,
  mergeRelationshipContext,
  normalizeContextResponse,
  normalizeLikesResponse,
  normalizeThreadResponse,
} from "./normalize.ts";

export const snapshotPattern = /^(likes|bookmarks)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:-page-\d{3})?\.json$/;
const normalizedSnapshotPattern = /^x-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.normalized\.json$/;

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

/** The full merged snapshot only; per-post preview snapshots are intentionally excluded. */
export async function latestNormalizedSnapshot(
  directory = resolve("data/normalized"),
): Promise<string | undefined> {
  try {
    const name = (await readdir(directory))
      .filter((candidate) => normalizedSnapshotPattern.test(candidate))
      .sort()
      .at(-1);
    return name ? resolve(directory, name) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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

/**
 * Keeps the last filename per key. Capture filenames end in a sortable
 * timestamp, so sorting by name puts the newest capture for a key last.
 */
function latestByKey(
  names: string[],
  keyOf: (name: string) => string | undefined,
): string[] {
  const latest = new Map<string, string>();
  for (const name of [...names].sort()) {
    const key = keyOf(name);
    if (key) latest.set(key, name);
  }
  return [...latest.values()];
}

export async function loadSnapshots(paths: string[]): Promise<SavedPost[]> {
  const posts = mergeSavedPosts(
    (
      await Promise.all(
        paths.map(async (path) =>
          normalizeLikesResponse(
            await readJson(path),
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
    const response = await readJson(resolve(directory, latest));
    post.relationships.push(...normalizeThreadResponse(response, post));
  }
  for (const post of posts) {
    const prefix = `context-${post.id}-`;
    const contextCaptures = latestByKey(
      names.filter((candidate) => candidate.startsWith(prefix)),
      (name) => name.slice(prefix.length).split("-", 1)[0],
    );
    for (const name of contextCaptures) {
      const response = await readJson(resolve(directory, name));
      if (!hasUsableContextPost(response)) continue;
      const context = normalizeContextResponse(response);
      const existing = post.relationships.find(
        (relationship) => relationship.postId === context.postId,
      );
      if (existing) {
        Object.assign(existing, mergeRelationshipContext(existing, context));
      } else {
        post.relationships.push(context);
      }
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
    for (const name of latestByKey(
      captures.filter((candidate) => candidate.endsWith(".json")),
      (candidate) => candidate.match(/^page-([a-f0-9]{12})-/)?.[1],
    )) {
      const capture = await readJson(resolve(webRoot, name));
      post.fragments.push(webPageFragment(capture));
    }
  }
  return posts;
}
