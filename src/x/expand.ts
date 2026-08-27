import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { LinkFragment, SavedPost, TextFragment } from "../model.ts";
import { fetchConversationRaw, fetchPostRaw } from "./client.ts";
import { hasUsableContextPost } from "./normalize.ts";
import { fetchWebPage } from "../web/page.ts";

export const MAX_LINKS_PER_POST = 5;

export interface CaptureResult {
  status: "captured" | "skipped";
  path?: string;
  count?: number;
}

export interface LinkCaptureResult {
  captured: number;
  skipped: number;
  failures: string[];
}

export interface ExpansionSummary {
  threadsCaptured: number;
  contextsCaptured: number;
  linksCaptured: number;
  linksSkipped: number;
  failures: string[];
}

export type SourceGapKind =
  | "missing_referenced_context"
  | "thread_marker_without_continuation"
  | "unexpanded_external_links"
  | "visual_analysis_pending"
  | "translation_pending"
  | "synthesis_pending";

export interface SourceGap {
  kind: SourceGapKind;
  message: string;
}

function timestamp(now: Date): string {
  return now.toISOString().slice(0, 19).replaceAll(":", "-");
}

async function hasCapture(directory: string, prefix: string): Promise<boolean> {
  try {
    return (await readdir(directory)).some(
      (name) => name.startsWith(prefix) && name.endsWith(".json"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function textOf(post: SavedPost): string {
  return post.fragments.find(
    (fragment): fragment is TextFragment => fragment.kind === "text",
  )?.text ?? "";
}

/** Keep automatic thread expansion conservative; explicit thread markers are the signal. */
export function shouldExpandThread(post: SavedPost): boolean {
  const text = textOf(post);
  return /(?:\bthread\b|🧵|\[\s*🧵\s*\]|\b\d+\s*\/\s*\d+\b)/iu.test(text);
}

export function externalUrlsForPost(post: SavedPost): string[] {
  const links: LinkFragment[] = [
    ...post.fragments.filter(
      (fragment): fragment is LinkFragment => fragment.kind === "link",
    ),
    ...post.relationships.flatMap(({ links: relationshipLinks }) =>
      relationshipLinks ?? [],
    ),
  ];
  return [...new Set(links.flatMap(({ url }) => {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return ["x.com", "twitter.com", "t.co", "twimg.com"].some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      )
        ? []
        : [new URL(url).toString()];
    } catch {
      return [];
    }
  }))];
}

function onlyUrls(text: string): boolean {
  const tokens = text.trim().split(/\s+/u);
  return tokens.length > 0 && tokens.every((token) => /^https?:\/\/\S+$/u.test(token));
}

export function needsRelationshipContext(
  relationship: SavedPost["relationships"][number],
): boolean {
  if (!["replied_to", "quoted"].includes(relationship.type)) return false;
  return !relationship.text?.trim() || onlyUrls(relationship.text);
}

/** Actionable gaps only; ordinary visual-model uncertainty stays with its media. */
export function sourceGapsForPost(post: SavedPost): SourceGap[] {
  const gaps: SourceGap[] = [];
  const missingContext = post.relationships.filter(needsRelationshipContext).length;
  if (missingContext) {
    gaps.push({
      kind: "missing_referenced_context",
      message: `${missingContext} referenced post${missingContext === 1 ? "" : "s"} lacks readable captured context.`,
    });
  }
  if (shouldExpandThread(post) && !post.relationships.some(({ type }) => type === "thread_continuation")) {
    gaps.push({
      kind: "thread_marker_without_continuation",
      message: "The post signals a thread, but no same-author continuation was captured.",
    });
  }
  const capturedUrls = new Set(
    post.fragments.flatMap((fragment) =>
      fragment.kind === "web_page" ? [fragment.sourceUrl, fragment.url] : [],
    ),
  );
  const unexpandedLinks = externalUrlsForPost(post).filter((url) => !capturedUrls.has(url)).length;
  if (unexpandedLinks) {
    gaps.push({
      kind: "unexpanded_external_links",
      message: `${unexpandedLinks} external link${unexpandedLinks === 1 ? " has" : "s have"} not been captured as readable page text.`,
    });
  }
  const pendingVisualAnalysis = post.fragments.filter(
    (fragment) =>
      fragment.kind === "media" &&
      fragment.role === "attachment" &&
      !fragment.extraction,
  ).length;
  if (pendingVisualAnalysis) {
    gaps.push({
      kind: "visual_analysis_pending",
      message: `${pendingVisualAnalysis} attached media item${pendingVisualAnalysis === 1 ? "" : "s"} still needs visual analysis.`,
    });
  }
  const text = post.fragments.find(
    (fragment): fragment is TextFragment => fragment.kind === "text",
  );
  if (text?.language && !["en", "und", "zxx"].includes(text.language) && !text.translation) {
    gaps.push({
      kind: "translation_pending",
      message: `English translation is pending for the ${text.language} source text.`,
    });
  }
  if (!post.enrichment) {
    gaps.push({
      kind: "synthesis_pending",
      message: "Post synthesis is pending.",
    });
  }
  return gaps;
}

export async function captureContextForPost(
  post: SavedPost,
  contextId: string,
  bearerToken: string,
  rawDirectory = "data/raw",
  now = new Date(),
): Promise<CaptureResult> {
  const directory = resolve(rawDirectory);
  const prefix = `context-${post.id}-${contextId}-`;
  if (await hasCapture(directory, prefix)) return { status: "skipped" };
  const body = await fetchPostRaw(bearerToken, contextId);
  if (!hasUsableContextPost(JSON.parse(body))) {
    throw new Error(`X context post ${contextId} was not available`);
  }
  const path = resolve(directory, `${prefix}${timestamp(now)}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, body, { encoding: "utf8", flag: "wx" });
  return { status: "captured", path, count: 1 };
}

export async function captureThreadForPost(
  post: SavedPost,
  bearerToken: string,
  rawDirectory = "data/raw",
  now = new Date(),
): Promise<CaptureResult> {
  const directory = resolve(rawDirectory);
  const prefix = `thread-${post.id}-`;
  if (await hasCapture(directory, prefix)) return { status: "skipped" };
  if (!post.author.username) {
    throw new Error(`Post ${post.id} has no captured username`);
  }
  if (!post.createdAt) {
    throw new Error(`Post ${post.id} has no captured creation time`);
  }
  const body = await fetchConversationRaw({
    bearerToken,
    conversationId: post.conversationId ?? post.id,
    username: post.author.username,
    createdAt: post.createdAt,
  });
  const path = resolve(directory, `${prefix}${timestamp(now)}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, body, { encoding: "utf8", flag: "wx" });
  const response = JSON.parse(body) as { data?: unknown };
  return {
    status: "captured",
    path,
    count: Array.isArray(response.data) ? response.data.length : 0,
  };
}

async function capturedWebUrls(directory: string): Promise<Set<string>> {
  const urls = new Set<string>();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return urls;
    throw error;
  }
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    try {
      const capture = JSON.parse(await readFile(join(directory, name), "utf8")) as {
        sourceUrl?: unknown;
        finalUrl?: unknown;
      };
      for (const value of [capture.sourceUrl, capture.finalUrl]) {
        if (typeof value === "string") urls.add(value);
      }
    } catch {
      // Ignore unrelated or incomplete metadata files; the next capture can retry.
    }
  }
  return urls;
}

async function captureExternalLink(
  post: SavedPost,
  sourceUrl: string,
  rawDirectory: string,
  now: Date,
): Promise<string> {
  const page = await fetchWebPage(sourceUrl);
  const capturedAt = new Date().toISOString();
  const hash = createHash("sha256").update(sourceUrl).digest("hex").slice(0, 12);
  const relativeRoot = join(rawDirectory, "web", post.id);
  const basename = `page-${hash}-${timestamp(now)}`;
  const rawPath = join(relativeRoot, `${basename}.html`);
  const metadataPath = join(relativeRoot, `${basename}.json`);
  await mkdir(resolve(relativeRoot), { recursive: true });
  await writeFile(resolve(rawPath), page.bytes, { flag: "wx" });
  await writeFile(
    resolve(metadataPath),
    `${JSON.stringify({
      sourceUrl: page.sourceUrl,
      finalUrl: page.finalUrl,
      contentType: page.contentType,
      title: page.title,
      ...(page.byline ? { byline: page.byline } : {}),
      ...(page.excerpt ? { excerpt: page.excerpt } : {}),
      text: page.text,
      capturedAt,
      rawPath,
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return metadataPath;
}

export async function captureLinksForPost(
  post: SavedPost,
  rawDirectory = "data/raw",
  now = new Date(),
): Promise<LinkCaptureResult> {
  const urls = externalUrlsForPost(post);
  const captured = await capturedWebUrls(resolve(rawDirectory, "web", post.id));
  const result: LinkCaptureResult = { captured: 0, skipped: 0, failures: [] };
  for (const url of urls.slice(0, MAX_LINKS_PER_POST)) {
    if (captured.has(url)) {
      result.skipped += 1;
      continue;
    }
    try {
      await captureExternalLink(post, url, rawDirectory, now);
      result.captured += 1;
      captured.add(url);
    } catch (error) {
      result.failures.push(
        `${post.id} ${url}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  result.skipped += Math.max(0, urls.length - MAX_LINKS_PER_POST);
  return result;
}

export async function expandThreadsAndContexts(
  posts: SavedPost[],
  bearerToken: string,
  rawDirectory = "data/raw",
  now = new Date(),
): Promise<ExpansionSummary> {
  const summary: ExpansionSummary = {
    threadsCaptured: 0,
    contextsCaptured: 0,
    linksCaptured: 0,
    linksSkipped: 0,
    failures: [],
  };
  for (const post of posts) {
    for (const relationship of post.relationships.filter(needsRelationshipContext)) {
      try {
        const result = await captureContextForPost(
          post,
          relationship.postId,
          bearerToken,
          rawDirectory,
          now,
        );
        if (result.status === "captured") summary.contextsCaptured += 1;
      } catch (error) {
        summary.failures.push(
          `context ${post.id}/${relationship.postId}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    if (!shouldExpandThread(post)) continue;
    try {
      const result = await captureThreadForPost(post, bearerToken, rawDirectory, now);
      if (result.status === "captured") summary.threadsCaptured += 1;
    } catch (error) {
      summary.failures.push(
        `thread ${post.id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  return summary;
}

export async function expandExternalLinks(
  posts: SavedPost[],
  rawDirectory = "data/raw",
  now = new Date(),
): Promise<ExpansionSummary> {
  const summary: ExpansionSummary = {
    threadsCaptured: 0,
    contextsCaptured: 0,
    linksCaptured: 0,
    linksSkipped: 0,
    failures: [],
  };
  for (const post of posts) {
    const result = await captureLinksForPost(post, rawDirectory, now);
    summary.linksCaptured += result.captured;
    summary.linksSkipped += result.skipped;
    summary.failures.push(...result.failures);
  }
  return summary;
}
