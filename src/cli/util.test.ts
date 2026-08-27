import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { SavedPost } from "../model.ts";
import { synthesisFingerprint, SYNTHESIS_PROMPT_VERSION } from "../llm/enrich-post.ts";
import {
  applyEnvAssignments,
  datedDirectories,
  envAssignment,
  hydrateCachedSourceContext,
  hydrateCachedSynthesis,
  loadCachedAssessment,
  mapWithConcurrency,
  modelDirectory,
  parseArgument,
  parseArguments,
  parseLimitArgument,
  reconcileGeneratedPreviewNotes,
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

test("reads repeated and single --flag= values off the command line", () => {
  const argv = ["node", "cli.ts", "--post=1", "--refresh", "--post=2", "--context=3"];
  assert.deepEqual(parseArguments(argv, "post"), ["1", "2"]);
  assert.equal(parseArgument(argv, "post"), "1");
  assert.equal(parseArgument(argv, "context"), "3");
  assert.equal(parseArgument(argv, "missing"), undefined);
  assert.deepEqual(parseArguments(argv, "missing"), []);
  // A bare flag is not a value-carrying argument.
  assert.equal(parseArgument(["--refresh"], "refresh"), undefined);
});

test("maps independent work with a bounded concurrency and stable result order", async () => {
  let active = 0;
  let maximumActive = 0;
  const results = await mapWithConcurrency(["first", "second", "third"], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return value.toUpperCase();
  });
  assert.deepEqual(results, ["FIRST", "SECOND", "THIRD"]);
  assert.equal(maximumActive, 2);
});

test("lists dated cache directories newest first and tolerates a missing root", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "x-ingestion-dated-"));
  try {
    for (const name of ["2026-01-02", "2026-02-01", "2025-12-31", "raw", "not-a-date"]) {
      await mkdir(resolve(directory, name), { recursive: true });
    }
    await writeFile(resolve(directory, "2026-03-03"), "not a directory", "utf8");
    assert.deepEqual(await datedDirectories(directory), [
      "2026-02-01",
      "2026-01-02",
      "2025-12-31",
    ]);
    assert.deepEqual(await datedDirectories(resolve(directory, "absent")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes only stale generated preview names for rendered posts", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "x-ingestion-preview-"));
  const generated = (postId: string) => `---\ntype: x-capture\nsource: x\npost_id: ${JSON.stringify(postId)}\n---\n`;
  try {
    await Promise.all([
      writeFile(resolve(directory, "Old_title--1.md"), generated("1"), "utf8"),
      writeFile(resolve(directory, "New_title--1.md"), generated("1"), "utf8"),
      writeFile(resolve(directory, "Old_title--2.md"), generated("2"), "utf8"),
      writeFile(resolve(directory, "Manual--1.md"), "# Manual note\n", "utf8"),
      writeFile(resolve(directory, "Not_generated--1.md"), "---\npost_id: \"1\"\n---\n", "utf8"),
    ]);

    assert.deepEqual(
      await reconcileGeneratedPreviewNotes(directory, new Map([["1", "New_title--1.md"]])),
      ["Old_title--1.md"],
    );
    assert.deepEqual((await readdir(directory)).sort(), [
      "Manual--1.md",
      "New_title--1.md",
      "Not_generated--1.md",
      "Old_title--2.md",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hydrates a video's vision cache written without the frames suffix", async () => {
  const enrichmentRoot = await mkdtemp(resolve(tmpdir(), "x-ingestion-vision-"));
  try {
    const visionRoot = resolve(enrichmentRoot, "vision", "qwen_qwen3-vl-32b-instruct");
    await mkdir(visionRoot, { recursive: true });
    // A video without an mp4 variant is analysed as a still, so the preview
    // writes `<mediaKey>.json` rather than `<mediaKey>-frames.json`.
    await writeFile(
      resolve(visionRoot, "video-key.json"),
      JSON.stringify({ extraction: { language: "en", verbatimText: "still frame" } }),
      "utf8",
    );
    await writeFile(
      resolve(visionRoot, "framed-key-frames.json"),
      JSON.stringify({ extraction: { language: "en", verbatimText: "contact sheet" } }),
      "utf8",
    );
    const post = {
      id: "1",
      fragments: [
        { kind: "media", mediaKey: "video-key", mediaType: "video", role: "attachment" },
        { kind: "media", mediaKey: "framed-key", mediaType: "video", role: "attachment" },
      ],
    } as unknown as SavedPost;

    await hydrateCachedSourceContext([post], enrichmentRoot);

    assert.deepEqual(
      post.fragments.map((fragment) =>
        fragment.kind === "media" ? fragment.extraction?.verbatimText : undefined,
      ),
      ["still frame", "contact sheet"],
    );
  } finally {
    await rm(enrichmentRoot, { recursive: true, force: true });
  }
});

test("hydrates only a matching cached synthesis", async () => {
  const enrichmentRoot = await mkdtemp(resolve(tmpdir(), "x-ingestion-synthesis-"));
  const model = "openai/gpt-5.6-luna";
  const post = {
    id: "1",
    url: "https://x.com/author/status/1",
    author: { id: "author" },
    fragments: [{ kind: "text", source: "post", text: "Useful source" }],
    relationships: [],
  } as unknown as SavedPost;
  const enrichment = {
    summary: "Useful summary.",
    topics: [],
    concepts: [],
    technologies: [],
    people: [],
    claims: [],
    relevance: "Useful.",
    model,
    promptVersion: SYNTHESIS_PROMPT_VERSION,
  };
  try {
    const directory = resolve(
      enrichmentRoot,
      "synthesis",
      SYNTHESIS_PROMPT_VERSION,
      modelDirectory(model),
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "1.json"),
      JSON.stringify({ sourceHash: synthesisFingerprint(post), enrichment }),
      "utf8",
    );

    await hydrateCachedSynthesis([post], model, enrichmentRoot);
    assert.deepEqual(post.enrichment, enrichment);

    delete post.enrichment;
    post.fragments = [{ kind: "text", source: "post", text: "Changed" }];
    await hydrateCachedSynthesis([post], model, enrichmentRoot);
    assert.equal(post.enrichment, undefined);
  } finally {
    await rm(enrichmentRoot, { recursive: true, force: true });
  }
});

test("derives one directory name per model across commands", () => {
  assert.equal(modelDirectory("qwen/qwen3-vl-32b-instruct"), "qwen_qwen3-vl-32b-instruct");
  assert.equal(modelDirectory("openai/gpt-5.6-luna"), "openai_gpt-5.6-luna");
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
    reportTitle(
      post([
        { kind: "text", source: "post", text: "https://t.co/a" },
        {
          kind: "web_page",
          sourceUrl: "https://example.com/a",
          url: "https://example.com/a",
          contentType: "text/html",
          title: "Captured  page",
          text: "body",
          capturedAt: "2026-08-19T00:00:00Z",
          rawPath: "data/raw/web/1/page.html",
        },
      ]),
    ),
    "Captured page",
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
