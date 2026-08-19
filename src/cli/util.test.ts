import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { SavedPost } from "../model.ts";
import {
  applyEnvAssignments,
  envAssignment,
  loadCachedAssessment,
  modelDirectory,
  parseLimitArgument,
  reportTitle,
} from "./util.ts";

const execFileAsync = promisify(execFile);

/** Reads the values back the way `npm run fetch:x` will: through Node's parser. */
async function roundTrip(contents: string, names: string[]): Promise<unknown> {
  const directory = await mkdtemp(resolve(tmpdir(), "x-ingestion-env-"));
  const path = resolve(directory, ".env");
  await writeFile(path, contents, "utf8");
  const { stdout } = await execFileAsync(process.execPath, [
    `--env-file=${path}`,
    "-e",
    `console.log(JSON.stringify(${JSON.stringify(names)}.map((name) => process.env[name])))`,
  ]);
  return JSON.parse(stdout) as unknown;
}

test("rewrites an existing env value without expanding replacement patterns", async () => {
  const updated = applyEnvAssignments('X_BEARER_TOKEN="old"\nOTHER=keep\n', [
    ["X_BEARER_TOKEN", "new$&token$1"],
  ]);
  assert.match(updated, /^OTHER=keep$/m);
  assert.deepEqual(await roundTrip(updated, ["X_BEARER_TOKEN", "OTHER"]), [
    "new$&token$1",
    "keep",
  ]);
});

test("appends an env value that is not present yet", async () => {
  const updated = applyEnvAssignments("OTHER=keep", [
    ["X_REFRESH_TOKEN", "fresh-token"],
  ]);
  assert.deepEqual(await roundTrip(updated, ["OTHER", "X_REFRESH_TOKEN"]), [
    "keep",
    "fresh-token",
  ]);
});

test("round-trips env values through the characters Node's parser treats specially", async () => {
  const values = ["plain-token", "with#hash", "with\\backslash", "with'apostrophe", "  padded  "];
  const contents = values
    .map((value, index) => envAssignment(`TOKEN_${index}`, value))
    .join("\n");
  assert.deepEqual(
    await roundTrip(contents, values.map((_, index) => `TOKEN_${index}`)),
    values,
  );
});

test("refuses to write an env value it cannot encode losslessly", () => {
  assert.throws(() => envAssignment("X_BEARER_TOKEN", `both"and'quotes`), /Cannot write/);
  assert.throws(() => envAssignment("X_BEARER_TOKEN", "two\nlines"), /Cannot write/);
});

test("parses --limit and rejects values that are not positive integers", () => {
  assert.equal(parseLimitArgument(["node", "cli.ts"]), Number.POSITIVE_INFINITY);
  assert.equal(parseLimitArgument(["--limit=5"]), 5);
  assert.throws(() => parseLimitArgument(["--limit=5x"]), /positive integer/);
  assert.throws(() => parseLimitArgument(["--limit=0"]), /positive integer/);
  assert.throws(() => parseLimitArgument(["--limit=-3"]), /positive integer/);
});

test("derives one directory name per model across commands", () => {
  assert.equal(modelDirectory("qwen/qwen3-vl-32b-instruct"), "qwen_qwen3-vl-32b-instruct");
  assert.equal(modelDirectory("openai/gpt-5-mini"), "openai_gpt-5-mini");
});

test("builds a single-line report title from an article, text, or the post url", () => {
  const post = (fragments: SavedPost["fragments"]): SavedPost =>
    ({ id: "1", url: "https://x.com/author/status/1", fragments }) as SavedPost;

  assert.equal(
    reportTitle(
      post([
        { kind: "text", source: "post", text: "ignored" },
        { kind: "article", title: "Title\nover  lines", text: "b", codeBlocks: [], mediaKeys: [] },
      ]),
    ),
    "Title over lines",
  );
  assert.equal(
    reportTitle(post([{ kind: "text", source: "post", text: "  spaced\ntext https://t.co/a " }])),
    "spaced text",
  );
  assert.equal(
    reportTitle(post([{ kind: "text", source: "post", text: "https://t.co/a" }])),
    "https://x.com/author/status/1",
  );
  assert.equal(reportTitle(post([{ kind: "text", source: "post", text: "x".repeat(150) }])).length, 100);
});

test("applies reviewed relevance decisions after cached model triage", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "x-ingestion-relevance-"));
  const postId = "1535341564016349185";
  await writeFile(
    resolve(directory, `${postId}.json`),
    JSON.stringify({
      assessment: {
        postId,
        status: "unclear",
        reason: "The model wanted more context.",
        needsWebCheck: false,
        webQuery: null,
      },
    }),
    "utf8",
  );
  const assessment = await loadCachedAssessment(
    directory,
    {
      id: postId,
      url: `https://x.com/i/web/status/${postId}`,
      createdAt: "2022-01-01T00:00:00Z",
      capturedAt: "2026-08-19T00:00:00Z",
      author: { id: "1" },
      fragments: [{ kind: "text", source: "post", text: "The XOR trick finds the non-duplicate." }],
      relationships: [],
      captureMethods: ["like"],
      rawSources: [],
    },
    "2026-08-19",
  );
  assert.equal(assessment?.status, "durable");
  assert.match(assessment?.reason ?? "", /XOR/);
});
