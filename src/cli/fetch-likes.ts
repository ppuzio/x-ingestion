import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  refreshXUserToken,
  XApiError,
  type XCollection,
} from "../x/client.ts";
import { fetchAndSaveCollection } from "../x/fetch-likes.ts";

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}; copy .env.example to .env and set it`);
  }
  return value;
}

async function main(): Promise<void> {
  const userId = requiredEnvironmentVariable("X_USER_ID");
  let bearerToken = requiredEnvironmentVariable("X_BEARER_TOKEN");
  const now = new Date();
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
        });
      } catch (error) {
        const refreshToken = process.env.X_REFRESH_TOKEN?.trim();
        const clientId = process.env.X_CLIENT_ID?.trim();
        if (
          !(error instanceof XApiError) ||
          error.status !== 401 ||
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
        const updatedEnv = [
          ["X_BEARER_TOKEN", tokens.accessToken],
          ["X_REFRESH_TOKEN", tokens.refreshToken],
        ].reduce((contents, [name, value]) => {
          const pattern = new RegExp(`^${name}=.*$`, "m");
          const line = `${name}=${JSON.stringify(value)}`;
          return pattern.test(contents)
            ? contents.replace(pattern, line)
            : `${contents.trimEnd()}\n${line}\n`;
        }, env);
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
        });
      }

      fetchedAny = true;
      console.log(
        `Saved ${result.postCount} ${collection} across ${result.paths.length} raw page(s)`,
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
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
