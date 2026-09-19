import { object, readJson } from "./json.ts";
import type { ContentFragment, SavedPost } from "./model.ts";
import { collapseWhitespace } from "./text.ts";
import { sourceGapsForPost, type SourceGap } from "./x/expand.ts";
import {
  latestNormalizedSnapshot,
  latestSnapshots,
  loadSnapshots,
} from "./x/snapshots.ts";

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
  evidence?: Array<{ location: string; text: string }>;
  sourceGaps?: SourceGap[];
  freshness?: SavedPost["relevance"];
  score: number;
}

export interface SearchResultCard extends SearchCard {
  sourceNotePath: string;
  sourceGaps: SourceGap[];
}

export interface ReadPostResult {
  postId: string;
  sourceUrl: string;
  sourceNotePath: string;
  conversationId?: string;
  createdAt?: string;
  capturedAt: string;
  author: SavedPost["author"];
  fragments: SavedPost["fragments"];
  relationships: SavedPost["relationships"];
  provenance: {
    captureMethods: SavedPost["captureMethods"];
    rawSources: Array<Pick<SavedPost["rawSources"][number], "method" | "snapshot">>;
  };
  generatedMetadata: {
    enrichment?: SavedPost["enrichment"];
    relevance?: SavedPost["relevance"];
  };
  sourceGaps: SourceGap[];
}

const POST_ID = /^\d+$/;

export function sourceNotePath(postId: string): string {
  if (!POST_ID.test(postId)) throw new Error("Post ID must contain only digits");
  return `Sources/x-${postId}.md`;
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

/** Bounded, overlapping source windows; locations point into read-post output. */
export function sourcePassages(post: SavedPost, query: string): Array<{ location: string; text: string }> {
  const terms = new Set(tokens(query));
  const sources = [
    ...post.fragments.flatMap((fragment, index) => stringsFor(fragment).map((text) => ({
      location: `fragments[${index}] (${fragment.kind})`, text,
    }))),
    ...post.relationships.flatMap((relationship, index) => [
      { location: `relationships[${index}].text`, text: relationship.text ?? "" },
      { location: `relationships[${index}].article`, text: relationship.article?.text ?? "" },
      ...(relationship.article?.codeBlocks ?? []).map(({ code }) => ({
        location: `relationships[${index}].article.codeBlocks`, text: code,
      })),
    ]),
  ];
  // ponytail: three 1,000-character windows bound each candidate; read-post
  // remains the full-evidence path when an answer needs more context.
  return sources.flatMap(({ location, text }) => {
    const windows = [];
    for (let start = 0; start < text.length; start += 880) {
      const passage = text.slice(start, start + 1_000);
      const matched = new Set(tokens(passage).filter((token) => terms.has(token)));
      windows.push({ location: `${location}, chars ${start}-${start + passage.length}`, text: passage, score: matched.size });
      if (start + 1_000 >= text.length) break;
    }
    return windows;
  }).sort((a, b) => b.score - a.score).slice(0, 3)
    .map(({ location, text }) => ({ location, text }));
}

function cardFor(post: SavedPost, score: number, query: string): SearchResultCard {
  const enrichment = post.enrichment;
  return {
    postId: post.id,
    sourceUrl: post.url,
    sourceNotePath: sourceNotePath(post.id),
    ...(post.author.username ? { author: `@${post.author.username}` } : {}),
    ...(post.createdAt ? { createdAt: post.createdAt } : {}),
    ...(enrichment?.summary ? { summary: enrichment.summary } : {}),
    topics: enrichment?.topics ?? [],
    concepts: enrichment?.concepts ?? [],
    technologies: enrichment?.technologies ?? [],
    people: enrichment?.people ?? [],
    claims: enrichment?.claims ?? [],
    sourceExcerpt: excerpt(post),
    evidence: sourcePassages(post, query),
    sourceGaps: sourceGapsForPost(post),
    ...(post.relevance ? { freshness: post.relevance } : {}),
    score,
  };
}

/** Returns all captured evidence for one post without the duplicate raw API payload. */
export function readPost(posts: SavedPost[], postId: string): ReadPostResult {
  const path = sourceNotePath(postId);
  const post = posts.find(({ id }) => id === postId);
  if (!post) throw new Error(`Post not found: ${postId}`);
  return {
    postId: post.id,
    sourceUrl: post.url,
    sourceNotePath: path,
    ...(post.conversationId ? { conversationId: post.conversationId } : {}),
    ...(post.createdAt ? { createdAt: post.createdAt } : {}),
    capturedAt: post.capturedAt,
    author: post.author,
    fragments: post.fragments,
    relationships: post.relationships,
    provenance: {
      captureMethods: post.captureMethods,
      rawSources: post.rawSources.map(({ method, snapshot }) => ({ method, snapshot })),
    },
    generatedMetadata: {
      ...(post.enrichment ? { enrichment: post.enrichment } : {}),
      ...(post.relevance ? { relevance: post.relevance } : {}),
    },
    sourceGaps: sourceGapsForPost(post),
  };
}

function newestFirst(a: SavedPost, b: SavedPost): number {
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id);
}

/** Returns compact, provenance-preserving cards for the local LLM query layer. */
export function searchPosts(
  posts: SavedPost[],
  query: string,
  limit = 40,
): SearchResultCard[] {
  if (!(limit > 0)) throw new Error("Search limit must be positive");
  if (!query.trim()) throw new Error("Search query must not be empty");
  const queryTokens = [...new Set(tokens(query))];
  const documents = posts.map((post) => ({
    post,
    source: new Set(tokens(sourceStrings(post).join(" "))),
    metadata: new Set(tokens(enrichmentStrings(post).join(" "))),
  }));
  const weights = new Map(queryTokens.map((token) => [token,
    Math.log(1 + posts.length / (1 + documents.filter(
      ({ source, metadata }) => source.has(token) || metadata.has(token),
    ).length)),
  ]));
  return documents
    .map(({ post, source, metadata }) => ({
      post,
      // Source matches outrank generated metadata; repeated terms add no weight.
      score: queryTokens.reduce((score, token) => score + weights.get(token)! *
        (source.has(token) ? 1 : metadata.has(token) ? 0.5 : 0), 0),
    }))
    .sort(
      (a, b) => b.score - a.score || newestFirst(a.post, b.post),
    )
    .slice(0, limit)
    .map(({ post, score }) => cardFor(post, score, query));
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

/** Loads the latest enriched canonical snapshot, with a raw-data fallback. */
export async function loadLatestPosts(): Promise<SavedPost[]> {
  const snapshot = await latestNormalizedSnapshot();
  if (snapshot) {
    const parsed: unknown = await readJson(snapshot);
    if (!Array.isArray(parsed) || !parsed.every(isSavedPost)) {
      throw new Error(`Invalid canonical snapshot: ${snapshot}`);
    }
    return parsed;
  }

  return loadSnapshots(await latestSnapshots());
}
