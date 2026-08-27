import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runMain } from "./util.ts";

const execFileAsync = promisify(execFile);

async function runStage(label: string, script: string, args: string[] = []): Promise<void> {
  console.log(`\n=== ${label} ===`);
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--env-file-if-exists=.env", script, ...args],
      { maxBuffer: 2_000_000 },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    if (failure.stdout) process.stdout.write(failure.stdout);
    if (failure.stderr) process.stderr.write(failure.stderr);
    throw error;
  }
}

async function main(): Promise<void> {
  await runStage("fetch likes and bookmarks", "src/cli/fetch-likes.ts");
  await runStage("expand missing threads, context, and links", "src/cli/expand.ts");
  await runStage("build enriched Obsidian previews", "src/cli/build-preview.ts", ["--enrich"]);
  console.log("\nIngestion complete");
}

runMain(main);
