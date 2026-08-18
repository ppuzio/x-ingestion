import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  parseRelevanceAssessments,
  protectRelevanceAssessments,
  type RelevanceAssessment,
} from "../llm/triage-relevance.ts";
import type { SavedPost } from "../model.ts";
import { collapseWhitespace, stripUrls } from "../text.ts";

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

export function parseLimitArgument(argv: string[]): number {
  const argument = argv.find((value) => value.startsWith("--limit="));
  if (!argument) return Number.POSITIVE_INFINITY;
  const raw = argument.slice("--limit=".length);
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
  return protectRelevanceAssessments(
    [post],
    parseRelevanceAssessments({ assessments: [cached.assessment] }, [post.id]),
    currentDate,
  )[0]!;
}

/** Single-line label for a post in a Markdown report link. */
export function reportTitle(post: SavedPost): string {
  const article = post.fragments.find((fragment) => fragment.kind === "article");
  const text = post.fragments.find((fragment) => fragment.kind === "text");
  const candidate =
    article?.title || stripUrls(text?.text ?? "").trim() || post.url;
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
