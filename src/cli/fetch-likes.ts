import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { fetchAndSaveLikes } from "../x/fetch-likes.ts";
import { refreshXUserToken, XApiError } from "../x/client.ts";

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
  let outputPath: string;
  try {
    outputPath = await fetchAndSaveLikes({ bearerToken, userId });
  } catch (error) {
    if (!(error instanceof XApiError) || error.status !== 401) throw error;

    const refreshToken = requiredEnvironmentVariable("X_REFRESH_TOKEN");
    const clientId = requiredEnvironmentVariable("X_CLIENT_ID");
    const envPath = resolve(".env");
    const env = await readFile(envPath, "utf8");
    const refreshed = await refreshXUserToken(refreshToken, clientId);
    bearerToken = refreshed.accessToken;
    const updatedEnv = [
      ["X_BEARER_TOKEN", refreshed.accessToken],
      ["X_REFRESH_TOKEN", refreshed.refreshToken],
    ].reduce(
      (contents, [name, value]) =>
        contents.replace(
          new RegExp(`^${name}=.*$`, "m"),
          `${name}=${JSON.stringify(value)}`,
        ),
      env,
    );
    const temporaryPath = `${envPath}.tmp`;
    await writeFile(temporaryPath, updatedEnv, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, envPath);
    outputPath = await fetchAndSaveLikes({ bearerToken, userId });
    console.log("Refreshed expired X user access token in .env");
  }

  console.log(`Saved raw X response to ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
