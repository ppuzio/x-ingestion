import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { object, readJson, writeJson } from "../json.ts";
import type { CaptureMethod, SavedPost } from "../model.ts";

export const SYNC_STATE_VERSION = 1;
export const DEFAULT_SYNC_STATE_PATH = resolve("data/state/sync.json");

export interface SyncPost {
  sourceHash: string;
  captureMethods: CaptureMethod[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SyncState {
  version: typeof SYNC_STATE_VERSION;
  updatedAt: string;
  posts: Record<string, SyncPost>;
}

export interface SyncSummary {
  total: number;
  newIds: string[];
  changedIds: string[];
  unchangedIds: string[];
}

function emptyState(): SyncState {
  return { version: SYNC_STATE_VERSION, updatedAt: "", posts: {} };
}

function isCaptureMethod(value: unknown): value is CaptureMethod {
  return value === "like" || value === "bookmark";
}

function parseState(value: unknown): SyncState {
  const candidate = object(value);
  if (!candidate) throw new Error("Sync state must be an object");
  if (candidate.version !== SYNC_STATE_VERSION || typeof candidate.updatedAt !== "string") {
    throw new Error("Unsupported sync state version");
  }
  const rawPosts = object(candidate.posts);
  if (!rawPosts) throw new Error("Sync state posts must be an object");
  const posts: Record<string, SyncPost> = {};
  for (const [id, entry] of Object.entries(rawPosts)) {
    const record = object(entry);
    if (!record) throw new Error(`Invalid sync state record for ${id}`);
    const methods = record.captureMethods;
    if (
      typeof record.sourceHash !== "string" ||
      typeof record.firstSeenAt !== "string" ||
      typeof record.lastSeenAt !== "string" ||
      !Array.isArray(methods) ||
      !methods.every(isCaptureMethod)
    ) {
      throw new Error(`Invalid sync state record for ${id}`);
    }
    posts[id] = {
      sourceHash: record.sourceHash,
      captureMethods: [...new Set(methods)],
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
    };
  }
  return { version: SYNC_STATE_VERSION, updatedAt: candidate.updatedAt, posts };
}

export async function readSyncState(path = DEFAULT_SYNC_STATE_PATH): Promise<SyncState> {
  try {
    return parseState(await readJson(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function writeSyncState(
  state: SyncState,
  path = DEFAULT_SYNC_STATE_PATH,
): Promise<void> {
  await writeJson(path, state);
}

/** Hashes the unchanged X post payload, independent of like/bookmark source. */
export function captureFingerprint(post: SavedPost): string {
  const rawPosts = post.rawSources
    .map(({ post: rawPost }) => rawPost)
    .map((rawPost) => JSON.stringify(rawPost))
    .filter((rawPost, index, values) => values.indexOf(rawPost) === index)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify({ id: post.id, rawPosts }))
    .digest("hex");
}

export function reconcileSyncState(
  previous: SyncState,
  posts: SavedPost[],
  now: string,
): { state: SyncState; summary: SyncSummary } {
  const newIds: string[] = [];
  const changedIds: string[] = [];
  const unchangedIds: string[] = [];
  const nextPosts = { ...previous.posts };
  for (const post of posts) {
    const sourceHash = captureFingerprint(post);
    const prior = previous.posts[post.id];
    if (!prior) newIds.push(post.id);
    else if (prior.sourceHash !== sourceHash) changedIds.push(post.id);
    else unchangedIds.push(post.id);
    nextPosts[post.id] = {
      sourceHash,
      captureMethods: [...post.captureMethods].sort(),
      firstSeenAt: prior?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
  }
  return {
    state: { version: SYNC_STATE_VERSION, updatedAt: now, posts: nextPosts },
    summary: {
      total: posts.length,
      newIds,
      changedIds,
      unchangedIds,
    },
  };
}
