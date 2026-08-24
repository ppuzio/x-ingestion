import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { object } from "./json.ts";
import type { ContentFragment, SavedPost } from "./model.ts";
import { collapseWhitespace } from "./text.ts";
import { latestSnapshots, loadSnapshots } from "./x/snapshots.ts";

const NORMALIZED_SNAPSHOT =
  /^x-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.normalized\.json$/;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "be",
  "can",
  "do",
  "for",
  "from",
  "give",
  "how",
  "i",
  "ideas",
  "in",
  "is",
  "it",
  "make",
  "me",
  "my",
  "of",
  "on",
  "some",
  "that",
  "the",
  "to",
  "with",
  "would",
  "you",
  "your",
]);

export interface SearchCard {
  postId: string;
  sourceUrl: string;
  author?: string;
  createdAt?: string;
  summary?: string;
  topics: string[];
  concepts: string[];
  technologies: string[];
  people: string[];
  claims: string[];
  sourceExcerpt: string;
  freshness?: SavedPost["relevance"];
  score: number;
}

function tokens(value: string): string[] {
  return [...value.toLocaleLowerCase().matchAll(/[\p{L}\p{N}]+/gu)]
    .map(([token]) => token)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function stringsFor(fragment: ContentFragment): string[] {
  switch (fragment.kind) {
    case "text":
      return [fragment.text, fragment.translation?.translatedText ?? ""];
    case "article":
      return [
        fragment.title,
        fragment.text,
        ...fragment.codeBlocks.map(({ code }) => code),
      ];
    case "web_page":
      return [fragment.title, fragment.byline ?? "", fragment.excerpt ?? "", fragment.text];
    case "link":
      return [fragment.title ?? "", fragment.url];
    case "media":
      return fragment.extraction
        ? [
            fragment.extraction.visualSummary,
            fragment.extraction.verbatimText,
            ...fragment.extraction.keyFacts,
          ]
        : [fragment.altText ?? ""];
  }
}

function sourceStrings(post: SavedPost): string[] {
  return [
    ...post.fragments.flatMap(stringsFor),
    ...post.relationships.flatMap((relationship) => [
      relationship.type,
      relationship.text ?? "",
      relationship.article?.title ?? "",
      relationship.article?.text ?? "",
      ...(relationship.links ?? []).flatMap((link) => [link.title ?? "", link.url]),
    ]),
  ];
}

function enrichmentStrings(post: SavedPost): string[] {
  const enrichment = post.enrichment;
  if (!enrichment) return [];
  return [
    enrichment.summary,
    ...enrichment.topics,
    ...enrichment.concepts,
    ...enrichment.technologies,
    ...enrichment.people,
    ...enrichment.claims,
    enrichment.relevance,
  ];
}

function excerpt(post: SavedPost): string {
  return collapseWhitespace(sourceStrings(post).filter(Boolean).join(" ")).slice(0, 900);
}

function cardFor(post: SavedPost, score: number): SearchCard {
  const enrichment = post.enrichment;
  return {
    postId: post.id,
    sourceUrl: post.url,
    ...(post.author.username ? { author: `@${post.author.username}` } : {}),
    ...(post.createdAt ? { createdAt: post.createdAt } : {}),
    ...(enrichment?.summary ? { summary: enrichment.summary } : {}),
    topics: enrichment?.topics ?? [],
    concepts: enrichment?.concepts ?? [],
    technologies: enrichment?.technologies ?? [],
    people: enrichment?.people ?? [],
    claims: enrichment?.claims ?? [],
    sourceExcerpt: excerpt(post),
    ...(post.relevance ? { freshness: post.relevance } : {}),
    score,
  };
}

function scorePost(post: SavedPost, query: string): number {
  const queryTokens = [...new Set(tokens(query))];
  if (!queryTokens.length) return 0;

  const strong = enrichmentStrings(post).join(" ").toLocaleLowerCase();
  const source = sourceStrings(post).join(" ").toLocaleLowerCase();
  const phrase = collapseWhitespace(query).toLocaleLowerCase();
  let score = strong.includes(phrase) ? 8 : 0;
  for (const token of queryTokens) {
    if (strong.includes(token)) score += 4;
    else if (source.includes(token)) score += 1;
  }
  return score;
}

function newestFirst(a: SavedPost, b: SavedPost): number {
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id);
}

/** Returns compact, provenance-preserving cards for the local LLM query layer. */
export function searchPosts(
  posts: SavedPost[],
  query: string,
  limit = 40,
): SearchCard[] {
  if (!(limit > 0)) throw new Error("Search limit must be positive");
  if (!query.trim()) throw new Error("Search query must not be empty");
  return posts
    .map((post) => ({ post, score: scorePost(post, query) }))
    .sort(
      (a, b) => b.score - a.score || newestFirst(a.post, b.post),
    )
    .slice(0, limit)
    .map(({ post, score }) => cardFor(post, score));
}

function isSavedPost(value: unknown): value is SavedPost {
  const candidate = object(value);
  return (
    typeof candidate?.id === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.capturedAt === "string" &&
    object(candidate.author) !== undefined &&
    Array.isArray(candidate.fragments) &&
    Array.isArray(candidate.relationships)
  );
}

async function latestNormalizedSnapshot(directory: string): Promise<string | undefined> {
  const names = await readdir(directory);
  return names
    .flatMap((name) => (NORMALIZED_SNAPSHOT.test(name) ? [name] : []))
    .sort()
    .at(-1);
}

/** Loads the latest enriched canonical snapshot, with a raw-data fallback. */
export async function loadLatestPosts(): Promise<SavedPost[]> {
  const directory = resolve("data/normalized");
  try {
    const name = await latestNormalizedSnapshot(directory);
    if (name) {
      const parsed: unknown = JSON.parse(await readFile(resolve(directory, name), "utf8"));
      if (!Array.isArray(parsed) || !parsed.every(isSavedPost)) {
        throw new Error(`Invalid canonical snapshot: ${name}`);
      }
      return parsed;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return loadSnapshots(await latestSnapshots());
}
