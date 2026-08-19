import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  parseRelevanceAssessments,
  protectRelevanceAssessments,
  type RelevanceAssessment,
} from "../llm/triage-relevance.ts";
import {
  parseRelevanceVerification,
  RELEVANCE_VERIFICATION_VERSION,
} from "../llm/verify-relevance.ts";
import type { ImageExtraction, SavedPost, Translation } from "../model.ts";
import { collapseWhitespace, stripUrls } from "../text.ts";

let relevanceConfigPromise: Promise<{
  overrides?: Record<string, { status?: unknown; reason?: unknown }>;
}> | undefined;

const RELEVANCE_CONFIG_PATH = "config/relevance.json";

function relevanceConfig(): Promise<{
  overrides?: Record<string, { status?: unknown; reason?: unknown }>;
}> {
  return relevanceConfigPromise ??= readFile(
    resolve(RELEVANCE_CONFIG_PATH),
    "utf8",
  ).then(
    (text) => {
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error(
          `${RELEVANCE_CONFIG_PATH} is not valid JSON: ${error instanceof Error ? error.message : error}`,
        );
      }
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return {};
      throw error;
    },
  );
}

/** Dated cache directories under `root`, newest first; empty when absent. */
export async function datedDirectories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map(({ name }) => name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function hydrateCachedSourceContext(
  posts: SavedPost[],
  enrichmentRoot = resolve("data/enrichment"),
): Promise<void> {
  const visionModel = modelDirectory(
    process.env.OPENROUTER_VISION_MODEL?.trim() || "qwen/qwen3-vl-32b-instruct",
  );
  const translationModel = modelDirectory(
    process.env.OPENROUTER_TRANSLATION_MODEL?.trim() ||
      "qwen/qwen3-vl-32b-instruct",
  );
  for (const post of posts) {
    for (const fragment of post.fragments) {
      // A video is analysed as frames only when it exposes an mp4 URL; without
      // one the preview falls back to the still image and writes the unsuffixed
      // cache, so both names have to be tried.
      const paths = fragment.kind === "media"
        ? (fragment.mediaType === "image" ? [""] : ["-frames", ""]).map((suffix) =>
            resolve(
              enrichmentRoot,
              "vision",
              visionModel,
              `${fragment.mediaKey}${suffix}.json`,
            ),
          )
        : fragment.kind === "text" && fragment.language &&
            !["en", "und", "zxx"].includes(fragment.language)
          ? [resolve(enrichmentRoot, "translation", translationModel, `${post.id}.json`)]
          : [];
      for (const path of paths) {
        if (!(await exists(path))) continue;
        const cached = JSON.parse(await readFile(path, "utf8")) as {
          extraction?: unknown;
          translation?: unknown;
        };
        if (fragment.kind === "media" && cached.extraction) {
          fragment.extraction = cached.extraction as ImageExtraction;
          break;
        }
        if (fragment.kind === "text" && cached.translation) {
          fragment.translation = cached.translation as Translation;
          break;
        }
      }
    }
  }
}

export async function hydrateCachedRelevance(
  posts: SavedPost[],
  model: string,
): Promise<void> {
  const root = resolve(
    "data/enrichment/relevance-verification",
    RELEVANCE_VERIFICATION_VERSION,
    modelDirectory(model),
  );
  const dates = await datedDirectories(root);
  for (const post of posts) {
    for (const date of dates) {
      const path = resolve(root, date, `${post.id}.json`);
      if (!(await exists(path))) continue;
      const cached = JSON.parse(await readFile(path, "utf8")) as {
        verification?: unknown;
        createdAt?: unknown;
      };
      const verification = parseRelevanceVerification(cached.verification, post.id);
      post.relevance = {
        ...verification,
        ...(typeof cached.createdAt === "string" ? { checkedAt: cached.createdAt } : {}),
      };
      break;
    }
  }
}

export function modelDirectory(model: string): string {
  return model.replace(/[^a-z0-9._-]+/gi, "_");
}

export function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}; copy .env.example to .env and set it`);
  }
  return value;
}

/** Every value passed as `--<flag>=<value>`, in command-line order. */
export function parseArguments(argv: string[], flag: string): string[] {
  const prefix = `--${flag}=`;
  return argv
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length));
}

/** The first value passed as `--<flag>=<value>`, if any. */
export function parseArgument(argv: string[], flag: string): string | undefined {
  return parseArguments(argv, flag)[0];
}

export function parseLimitArgument(argv: string[]): number {
  const raw = parseArgument(argv, "limit");
  if (raw === undefined) return Number.POSITIVE_INFINITY;
  const limit = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!(limit > 0)) throw new Error("--limit must be a positive integer");
  return limit;
}

/**
 * Reads one cached triage assessment. The deterministic protections are applied
 * on read so that a cached verdict and a fresh one agree, and so that every
 * command sees the same status for a post.
 */
export async function loadCachedAssessment(
  cacheRoot: string,
  post: SavedPost,
  currentDate: string,
): Promise<RelevanceAssessment | undefined> {
  const path = resolve(cacheRoot, `${post.id}.json`);
  if (!(await exists(path))) return undefined;
  const cached = JSON.parse(await readFile(path, "utf8")) as { assessment?: unknown };
  const [assessment] = protectRelevanceAssessments(
    [post],
    parseRelevanceAssessments({ assessments: [cached.assessment] }, [post.id]),
    currentDate,
  );
  const config = await relevanceConfig();
  const override = config.overrides?.[post.id];
  if (!override) return assessment!;
  if (
    !["durable", "non_knowledge", "unclear"].includes(
      typeof override.status === "string" ? override.status : "",
    ) ||
    typeof override.reason !== "string" ||
    !override.reason.trim()
  ) {
    throw new Error(`Invalid manual relevance override for ${post.id}`);
  }
  return {
    postId: post.id,
    status: override.status as "durable" | "non_knowledge" | "unclear",
    reason: collapseWhitespace(override.reason),
    needsWebCheck: false,
    webQuery: null,
  };
}

/** Single-line label for a post in a Markdown report link. */
export function reportTitle(post: SavedPost): string {
  const article = post.fragments.find((fragment) => fragment.kind === "article");
  const webPage = post.fragments.find((fragment) => fragment.kind === "web_page");
  const text = post.fragments.find((fragment) => fragment.kind === "text");
  const candidate =
    article?.title || webPage?.title || stripUrls(text?.text ?? "").trim() ||
    post.url;
  return collapseWhitespace(candidate).slice(0, 100);
}

/**
 * Node's `--env-file` parser takes a quoted value literally: it strips the outer
 * quotes and performs no unescaping. Quoting with a character the value does not
 * contain is therefore the only lossless encoding.
 */
export function envAssignment(name: string, value: string): string {
  const quote = !value.includes('"') ? '"' : !value.includes("'") ? "'" : undefined;
  if (!quote || /[\r\n]/.test(value)) {
    throw new Error(`Cannot write ${name} to .env: value contains quotes or newlines`);
  }
  return `${name}=${quote}${value}${quote}`;
}

export function applyEnvAssignments(
  contents: string,
  entries: Array<[name: string, value: string]>,
): string {
  return entries.reduce((current, [name, value]) => {
    const pattern = new RegExp(`^${name}=.*$`, "m");
    const line = envAssignment(name, value);
    // A replacer function keeps `$&` and friends in the value from being expanded.
    return pattern.test(current)
      ? current.replace(pattern, () => line)
      : `${current.trimEnd()}\n${line}\n`;
  }, contents);
}

export function runMain(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
