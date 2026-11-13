import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  refreshXUserToken,
  XApiError,
  type XCollection,
} from "../x/client.ts";
import { fetchAndSaveCollection } from "../x/fetch-likes.ts";
import { rawCollectionSnapshots, loadSnapshots } from "../x/snapshots.ts";
import {
  readSyncState,
  reconcileSyncState,
  writeSyncState,
} from "../x/sync.ts";
import { applyEnvAssignments, requiredEnvironmentVariable, runMain } from "./util.ts";

async function main(): Promise<void> {
  const userId = requiredEnvironmentVariable("X_USER_ID");
  let bearerToken = requiredEnvironmentVariable("X_BEARER_TOKEN");
  const forceRefresh = process.argv.includes("--refresh");
  const full = process.argv.includes("--full");
  const now = new Date();
  const previous = await readSyncState();
  // An empty set never matches, so `--full` pages through the whole collection.
  const knownIdsFor = (collection: XCollection): Set<string> => {
    if (full) return new Set();
    const method = collection === "likes" ? "like" : "bookmark";
    return new Set(
      Object.entries(previous.posts)
        .filter(([, post]) => post.captureMethods.includes(method))
        .map(([id]) => id),
    );
  };
  let refreshed = false;
  let fetchedAny = false;

  for (const collection of ["likes", "bookmarks"] satisfies XCollection[]) {
    try {
      let result: Awaited<ReturnType<typeof fetchAndSaveCollection>>;
      try {
        result = await fetchAndSaveCollection({
          bearerToken,
          userId,
          collection,
          now,
          knownIds: knownIdsFor(collection),
        });
      } catch (error) {
        const refreshToken = process.env.X_REFRESH_TOKEN?.trim();
        const clientId = process.env.X_CLIENT_ID?.trim();
        if (
          !(error instanceof XApiError) ||
          (error.status !== 401 && !(forceRefresh && error.status === 403)) ||
          refreshed ||
          !refreshToken ||
          !clientId
        ) {
          throw error;
        }

        const envPath = resolve(".env");
        const env = await readFile(envPath, "utf8");
        const tokens = await refreshXUserToken(refreshToken, clientId);
        bearerToken = tokens.accessToken;
        const updatedEnv = applyEnvAssignments(env, [
          ["X_BEARER_TOKEN", tokens.accessToken],
          ["X_REFRESH_TOKEN", tokens.refreshToken],
        ]);
        const temporaryPath = `${envPath}.tmp`;
        await writeFile(temporaryPath, updatedEnv, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporaryPath, envPath);
        refreshed = true;
        console.log("Refreshed expired X user access token in .env");
        result = await fetchAndSaveCollection({
          bearerToken,
          userId,
          collection,
          now,
          knownIds: knownIdsFor(collection),
        });
      }

      fetchedAny = true;
      console.log(
        `Saved ${result.postCount} ${collection} across ${result.paths.length} raw page(s)` +
          (result.reachedKnown ? " (stopped at previously captured posts)" : ""),
      );
    } catch (error) {
      if (error instanceof XApiError && [401, 403].includes(error.status)) {
        console.warn(`Skipped ${collection}: X rejected this token (${error.status})`);
        continue;
      }
      throw error;
    }
  }

  if (!fetchedAny) {
    throw new Error("X rejected both likes and bookmarks; check OAuth scopes");
  }

  const posts = await loadSnapshots(await rawCollectionSnapshots());
  const { state, summary } = reconcileSyncState(previous, posts, now.toISOString());
  await writeSyncState(state);
  console.log(
    `Sync state: ${summary.total} current (${summary.newIds.length} new, ` +
      `${summary.changedIds.length} changed, ${summary.unchangedIds.length} unchanged)`,
  );
}

runMain(main);
