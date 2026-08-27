import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { promisify } from "node:util";

import {
  enrichPost,
  synthesisFingerprint,
  SYNTHESIS_PROMPT_VERSION,
} from "../llm/enrich-post.ts";
import { extractImage, translateText } from "../llm/openrouter.ts";
import type {
  ImageExtraction,
  MediaFragment,
  PostEnrichment,
  SavedPost,
  TextFragment,
  Translation,
} from "../model.ts";
import { shouldArchiveVideo } from "../model.ts";
import {
  renderObsidianNote,
  type ConceptVocabulary,
} from "../obsidian/render.ts";
import { sourceGapsForPost, type SourceGap, type SourceGapKind } from "../x/expand.ts";
import {
  latestSnapshots,
  loadSnapshots,
  snapshotPattern,
} from "../x/snapshots.ts";
import {
  exists,
  hydrateCachedRelevance,
  hydrateCachedSourceContext,
  hydrateCachedSynthesis,
  mapWithConcurrency,
  modelDirectory,
  parseArgument,
  reconcileGeneratedPreviewNotes,
  requiredEnvironmentVariable,
  runMain,
  saveJson,
} from "./util.ts";

const previewRoot = resolve("data/obsidian-preview");
const enrichmentRoot = resolve("data/enrichment");
const execFileAsync = promisify(execFile);
// ponytail: three requests keep default provider limits and media downloads calm;
// expose a setting only if observed limits require tuning.
const ENRICHMENT_CONCURRENCY = 3;

const sourceGapTitles: Record<SourceGapKind, string> = {
  missing_referenced_context: "Missing referenced context",
  thread_marker_without_continuation: "Thread marker without continuation",
  unexpanded_external_links: "Unexpanded external links",
  visual_analysis_pending: "Visual analysis pending",
  translation_pending: "Translation pending",
  synthesis_pending: "Synthesis pending",
};

function reviewQueue(
  posts: SavedPost[],
  rendered: Array<{ id: string; filename: string; title: string }>,
): string {
  const gapsByPostId = new Map(posts.map((post) => [post.id, sourceGapsForPost(post)]));
  const groups = new Map<SourceGapKind, Array<{ note: typeof rendered[number]; gap: SourceGap }>>();
  for (const note of rendered) {
    for (const gap of gapsByPostId.get(note.id) ?? []) {
      const group = groups.get(gap.kind) ?? [];
      group.push({ note, gap });
      groups.set(gap.kind, group);
    }
  }
  const total = [...groups.values()].reduce((count, entries) => count + entries.length, 0);
  const lines = [
    "# Review queue",
    "",
    "Actionable source gaps found during the latest preview build. This report never changes source data.",
    "",
    `- Posts needing attention: ${new Set([...groups.values()].flat().map(({ note }) => note.id)).size}`,
    `- Gaps: ${total}`,
  ];
  for (const kind of Object.keys(sourceGapTitles) as SourceGapKind[]) {
    const entries = groups.get(kind);
    if (!entries?.length) continue;
    lines.push("", `## ${sourceGapTitles[kind]} (${entries.length})`, "");
    lines.push(
      ...entries.map(
        ({ note, gap }) => `- [[${note.filename.slice(0, -3)}|${note.title}]] — ${gap.message}`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

function extensionFor(url: string): string {
  const extension = extname(new URL(url).pathname).toLowerCase();
  return /^\.(png|jpe?g|webp|gif)$/.test(extension) ? extension : ".jpg";
}

async function videoDuration(path: string, durationMs?: number): Promise<number> {
  if (durationMs && durationMs > 0) return durationMs / 1_000;
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const duration = Number.parseFloat(stdout);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine video duration for ${path}`);
  }
  return duration;
}

async function createContactSheet(
  inputPath: string,
  outputPath: string,
  durationMs?: number,
): Promise<void> {
  if (await exists(outputPath)) return;
  await mkdir(dirname(outputPath), { recursive: true });
  const duration = await videoDuration(inputPath, durationMs);
  const start = duration * 0.08;
  const sampledDuration = Math.max(duration * 0.84, 0.1);
  const filter = [
    `trim=start=${start}:duration=${sampledDuration}`,
    "setpts=PTS-STARTPTS",
    `fps=${6 / sampledDuration}`,
    "scale=480:-2",
    "tile=3x2:padding=8:margin=8:color=black",
  ].join(",");
  await execFileAsync("ffmpeg", [
    "-v",
    "error",
    "-i",
    inputPath,
    "-vf",
    filter,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-y",
    outputPath,
  ]);
}

async function createRemoteContactSheet(
  inputUrl: string,
  outputPath: string,
  duration: number,
): Promise<void> {
  if (await exists(outputPath)) return;
  await mkdir(dirname(outputPath), { recursive: true });
  const timestamps = Array.from(
    { length: 6 },
    (_, index) => duration * (0.15 + index * 0.14),
  );
  const inputs = timestamps.flatMap((timestamp) => [
    "-rw_timeout",
    "30000000",
    "-ss",
    timestamp.toFixed(3),
    "-i",
    inputUrl,
  ]);
  const scales = timestamps
    .map((_, index) => `[${index}:v]scale=480:-2,setsar=1[v${index}]`)
    .join(";");
  const filter = [
    scales,
    "[v0][v1][v2]hstack=inputs=3[top]",
    "[v3][v4][v5]hstack=inputs=3[bottom]",
    "[top][bottom]vstack=inputs=2[out]",
  ].join(";");
  await execFileAsync(
    "ffmpeg",
    [
      "-v",
      "error",
      ...inputs,
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      "-frames:v",
      "1",
      "-q:v",
      "2",
      "-y",
      outputPath,
    ],
    { timeout: 120_000 },
  );
}

async function download(url: string, outputPath: string): Promise<void> {
  if (await exists(outputPath)) return;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Media download failed (${response.status}) for ${url}`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
}

async function cachedJson<T>(path: string): Promise<T | undefined> {
  if (!(await exists(path))) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function dataUrl(buffer: Buffer, path: string): string {
  const mime = extname(path).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/** An `apiKey` means enrichment is on; `main` resolves it once for the whole run. */
async function prepareMedia(
  post: SavedPost,
  apiKey: string | undefined,
  visionModel: string,
): Promise<void> {
  const media = post.fragments.filter(
    (fragment): fragment is MediaFragment => fragment.kind === "media",
  );

  for (const item of media) {
    // ponytail: inline article images remain remote until X exposes placement or
    // the preview proves a gallery is useful.
    if (item.role === "article") continue;
    // Cached frame analysis must replay through the same video path even when
    // this local render has no API key; otherwise delivery-only asset fields
    // change and invalidate an otherwise matching synthesis cache.
    const analyzeVideo = Boolean(
      item.mediaType !== "image" && item.url && (apiKey || item.extraction),
    );
    const sourceUrl = analyzeVideo ? item.url : item.mediaType === "image" ? item.url : item.previewUrl;
    if (!sourceUrl) continue;

    let analysisPath: string;
    if (analyzeVideo) {
      const relativePath = `attachments/x/${post.id}/${item.mediaKey}.mp4`;
      const outputPath = resolve(previewRoot, relativePath);
      const localVideo = (await exists(outputPath)) ? outputPath : undefined;
      let duration: number;
      try {
        duration = await videoDuration(localVideo ?? sourceUrl, item.durationMs);
      } catch (error) {
        if (!apiKey && item.extraction) {
          console.warn(
            `Media replay skipped for ${item.mediaKey}: ${error instanceof Error ? error.message : error}`,
          );
          continue;
        }
        throw error;
      }
      item.durationMs = Math.round(duration * 1_000);
      const contactSheetPath = `attachments/x/${post.id}/${item.mediaKey}-contact-sheet.jpg`;
      analysisPath = resolve(previewRoot, contactSheetPath);
      item.contactSheetPath = contactSheetPath;
      item.archived = shouldArchiveVideo(item.durationMs);
      if (item.archived) {
        await download(sourceUrl, outputPath);
        item.assetPath = relativePath;
        await createContactSheet(outputPath, analysisPath, item.durationMs);
      } else {
        await createRemoteContactSheet(sourceUrl, analysisPath, duration);
      }
    } else {
      const relativePath = `attachments/x/${post.id}/${item.mediaKey}${extensionFor(sourceUrl)}`;
      analysisPath = resolve(previewRoot, relativePath);
      await download(sourceUrl, analysisPath);
      item.assetPath = relativePath;
      if (item.mediaType !== "image") item.archived = false;
    }

    if (!apiKey || item.role !== "attachment") continue;
    const cachePath = resolve(
      enrichmentRoot,
      "vision",
      modelDirectory(visionModel),
      `${item.mediaKey}${analyzeVideo ? "-frames" : ""}.json`,
    );
    const cached = await cachedJson<{ extraction: ImageExtraction }>(cachePath);
    if (cached) {
      item.extraction = cached.extraction;
      continue;
    }
    try {
      const result = await extractImage(
        apiKey,
        visionModel,
        dataUrl(await readFile(analysisPath), analysisPath),
        analyzeVideo
          ? "This is a contact sheet of six frames sampled in chronological order from one video. Synthesize information across the sequence and do not treat repeated UI as separate facts."
          : undefined,
      );
      item.extraction = result.extraction;
      await saveJson(cachePath, {
        mediaKey: item.mediaKey,
        createdAt: new Date().toISOString(),
        ...result,
      });
    } catch (error) {
      console.warn(
        `Vision extraction failed for ${item.mediaKey}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

async function prepareTranslation(
  post: SavedPost,
  apiKey: string | undefined,
  translationModel: string,
): Promise<void> {
  const text = post.fragments.find(
    (fragment): fragment is TextFragment => fragment.kind === "text",
  );
  if (
    !apiKey ||
    !text?.language ||
    ["en", "und", "zxx"].includes(text.language)
  ) {
    return;
  }

  const cachePath = resolve(
    enrichmentRoot,
    "translation",
    modelDirectory(translationModel),
    `${post.id}.json`,
  );
  const cached = await cachedJson<{ translation: Translation }>(cachePath);
  if (cached) {
    text.translation = cached.translation;
    return;
  }
  try {
    const result = await translateText(
      apiKey,
      translationModel,
      text.language,
      text.text,
    );
    text.translation = result.translation;
    await saveJson(cachePath, {
      postId: post.id,
      createdAt: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    console.warn(
      `Translation failed for ${post.id}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function prepareSynthesis(
  post: SavedPost,
  apiKey: string | undefined,
  synthesisModel: string,
  refresh: boolean,
): Promise<void> {
  if (!refresh) {
    await hydrateCachedSynthesis([post], synthesisModel, enrichmentRoot);
    if (post.enrichment) return;
  }
  if (!apiKey) return;
  const cachePath = resolve(
    enrichmentRoot,
    "synthesis",
    SYNTHESIS_PROMPT_VERSION,
    modelDirectory(synthesisModel),
    `${post.id}.json`,
  );
  const sourceHash = synthesisFingerprint(post);
  const cached = await cachedJson<{
    enrichment: PostEnrichment;
    sourceHash?: string;
  }>(cachePath);
  if (!refresh && cached?.sourceHash === sourceHash) {
    post.enrichment = cached.enrichment;
    return;
  }
  try {
    const result = await enrichPost(apiKey, synthesisModel, post);
    post.enrichment = result.enrichment;
    await saveJson(cachePath, {
      postId: post.id,
      sourceHash,
      createdAt: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    // Keep the last good synthesis rather than downgrading the note to pending
    // because one call failed.
    if (cached) post.enrichment = cached.enrichment;
    console.warn(
      `Synthesis failed for ${post.id}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const enrich = arguments_.includes("--enrich");
  const refreshSynthesis = arguments_.includes("--refresh-synthesis");
  const postId = parseArgument(arguments_, "post");
  const requestedSnapshot = arguments_.find((argument) => !argument.startsWith("--"));
  const snapshots = requestedSnapshot
    ? [resolve(requestedSnapshot)]
    : await latestSnapshots();
  const visionModel =
    process.env.OPENROUTER_VISION_MODEL?.trim() || "qwen/qwen3-vl-32b-instruct";
  const translationModel =
    process.env.OPENROUTER_TRANSLATION_MODEL?.trim() ||
    "qwen/qwen3-vl-32b-instruct";
  const synthesisModel =
    process.env.OPENROUTER_SYNTHESIS_MODEL?.trim() ||
    "qwen/qwen3-vl-32b-instruct";
  const allPosts = await loadSnapshots(snapshots);
  await hydrateCachedSourceContext(allPosts);
  const verificationModel =
    process.env.OPENROUTER_VERIFICATION_MODEL?.trim() || "openai/gpt-5.6-luna";
  await hydrateCachedRelevance(allPosts, verificationModel);
  const posts = postId ? allPosts.filter(({ id }) => id === postId) : allPosts;
  if (postId && !posts.length) throw new Error(`Saved post ${postId} was not found`);
  const apiKey = enrich ? requiredEnvironmentVariable("OPENROUTER_KEY") : undefined;
  const conceptVocabulary = JSON.parse(
    await readFile(resolve("config/concepts.json"), "utf8"),
  ) as ConceptVocabulary;

  await mkdir(previewRoot, { recursive: true });
  const rendered = await mapWithConcurrency(
    posts,
    enrich ? ENRICHMENT_CONCURRENCY : 1,
    async (post) => {
      await prepareMedia(post, apiKey, visionModel);
      await prepareTranslation(post, apiKey, translationModel);
      await prepareSynthesis(post, apiKey, synthesisModel, refreshSynthesis);
      const note = renderObsidianNote(post, conceptVocabulary);
      await writeFile(resolve(previewRoot, note.filename), note.markdown, "utf8");
      return { id: post.id, ...note };
    },
  );
  const removed = await reconcileGeneratedPreviewNotes(
    previewRoot,
    new Map(rendered.map(({ id, filename }) => [id, filename])),
  );

  const normalizedPath = resolve(
    "data/normalized",
    `x-${basename(snapshots[0]!).match(snapshotPattern)?.[2] ?? Date.now()}${postId ? `-${postId}` : ""}.normalized.json`,
  );
  await saveJson(normalizedPath, posts);
  if (!postId) {
    await writeFile(resolve(previewRoot, "_Review_Queue.md"), reviewQueue(posts, rendered), "utf8");
    await writeFile(
      resolve(previewRoot, "_Index.md"),
      [
        "# X likes preview",
        "",
        "- [[_Review_Queue|Review queue]]",
        "",
        ...rendered.map(({ filename, title }) => `- [[${filename.slice(0, -3)}|${title}]]`),
        "",
      ].join("\n"),
      "utf8",
    );
  }

  console.log(
    `Generated ${posts.length} preview notes in ${previewRoot}${enrich ? " with configured enrichment" : ""}`,
  );
  if (removed.length) console.log(`Removed ${removed.length} stale preview note(s)`);
  console.log(`Saved canonical records to ${normalizedPath}`);
}

runMain(main);
