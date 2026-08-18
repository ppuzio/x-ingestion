import { fetchAndSaveLikes } from "../x/fetch-likes.ts";

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}; copy .env.example to .env and set it`);
  }
  return value;
}

async function main(): Promise<void> {
  const outputPath = await fetchAndSaveLikes({
    bearerToken: requiredEnvironmentVariable("X_BEARER_TOKEN"),
    userId: requiredEnvironmentVariable("X_USER_ID"),
  });

  console.log(`Saved raw X response to ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
