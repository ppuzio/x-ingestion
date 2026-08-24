import {
  number,
  object,
  objects,
  string,
  stringList,
  type JsonObject,
} from "../json.ts";
import type {
  ArticleFragment,
  ContentFragment,
  CaptureMethod,
  LinkFragment,
  MediaFragment,
  PostRelationship,
  SavedAuthor,
  SavedPost,
} from "../model.ts";

/**
 * Post ids and media keys end up in filesystem paths (note filenames, attachment
 * directories), so they are validated here rather than sanitized at each use.
 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]+$/;

function authorFrom(user: JsonObject | undefined, id: string): SavedAuthor {
  const username = string(user?.username);
  const name = string(user?.name);
  return {
    id,
    ...(username ? { username } : {}),
    ...(name ? { name } : {}),
  };
}

function usersById(includes: unknown): Map<string, JsonObject> {
  return new Map(
    objects(object(includes)?.users).flatMap((user) => {
      const id = string(user.id);
      return id ? [[id, user] as const] : [];
    }),
  );
}

function isExternalUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return !["x.com", "twitter.com", "pic.x.com"].includes(hostname);
  } catch {
    return false;
  }
}

function linksFromEntities(
  entities: unknown,
  source: LinkFragment["source"]
): LinkFragment[] {
  return objects(object(entities)?.urls).flatMap((entry) => {
    const url = string(entry.expanded_url) ?? string(entry.text);
    const title = string(entry.title);
    if (!url || !isExternalUrl(url)) return [];
    return [{ kind: "link", source, url, ...(title ? { title } : {}) }];
  });
}

function articleFrom(post: JsonObject): ArticleFragment | undefined {
  const article = object(post.article);
  const text = string(article?.plain_text);
  if (!article || !text) return undefined;

  const title =
    string(article.title) ??
    string(object(post.article_title)?.title) ??
    "Untitled X Article";
  const articleEntities = object(article.entities);
  const codeBlocks = objects(articleEntities?.code).flatMap((entry) => {
    const code = string(entry.code);
    const language = string(entry.language);
    return code ? [{ code, ...(language ? { language } : {}) }] : [];
  });

  return {
    kind: "article",
    title,
    text,
    codeBlocks,
    mediaKeys: stringList(article.media_entities),
  };
}

const VARIANTS_BIT_RATE = 1_500_000;

function mediaFrom(
  media: JsonObject,
  role: MediaFragment["role"]
): MediaFragment | undefined {
  const mediaKey = string(media.media_key);
  const xType = string(media.type);
  if (!mediaKey || !SAFE_IDENTIFIER.test(mediaKey) || !xType) return undefined;

  const mediaType =
    xType === "photo"
      ? "image"
      : xType === "video"
      ? "video"
      : xType === "animated_gif"
      ? "animated_gif"
      : undefined;
  if (!mediaType) return undefined;

  const variants = objects(media.variants)
    .filter((variant) => string(variant.content_type) === "video/mp4")
    .sort(
      (a, b) =>
        Math.abs((number(a.bit_rate) ?? 0) - VARIANTS_BIT_RATE) -
        Math.abs((number(b.bit_rate) ?? 0) - VARIANTS_BIT_RATE)
    );
  const url =
    string(media.url) ??
    (mediaType !== "image" ? string(variants[0]?.url) : undefined);
  const previewUrl = string(media.preview_image_url);
  const width = number(media.width);
  const height = number(media.height);
  const durationMs = number(media.duration_ms);
  const altText = string(media.alt_text);

  return {
    kind: "media",
    mediaKey,
    mediaType,
    role,
    ...(url ? { url } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(altText ? { altText } : {}),
  };
}

export function normalizeLikesResponse(
  input: unknown,
  rawSnapshot: string,
  capturedAt: string,
  captureMethod: CaptureMethod = "like",
): SavedPost[] {
  const response = object(input);
  if (!response || (response.data !== undefined && !Array.isArray(response.data))) {
    throw new Error("Raw X response data must be an array when present");
  }

  const includes = object(response.includes);
  const includedPosts = new Map(
    objects(includes?.posts).flatMap((post) => {
      const id = string(post.id);
      return id ? [[id, post] as const] : [];
    })
  );
  const users = usersById(includes);
  const media = new Map(
    objects(includes?.media).flatMap((item) => {
      const key = string(item.media_key);
      return key ? [[key, item] as const] : [];
    })
  );

  return (response.data ?? []).map((item, index) => {
    const post = object(item);
    const id = string(post?.id);
    const rootText = string(post?.text);
    const authorId = string(post?.author_id);
    if (!post || !id || rootText === undefined || !authorId) {
      throw new Error(`Invalid X post at data[${index}]`);
    }
    if (!SAFE_IDENTIFIER.test(id)) {
      throw new Error(`Unsafe X post id at data[${index}]: ${JSON.stringify(id)}`);
    }

    const author = authorFrom(users.get(authorId), authorId);
    const noteText = string(object(post.note_post)?.text);
    const language = string(post.lang);
    const article = articleFrom(post);
    const fragments: ContentFragment[] = [
      {
        kind: "text",
        source: noteText ? "note" : "post",
        text: noteText ?? rootText,
        ...(language ? { language } : {}),
      },
      ...(article ? [article] : []),
      ...linksFromEntities(post.entities, "post"),
      ...(article
        ? linksFromEntities(object(post.article)?.entities, "article")
        : []),
    ];

    const mediaByKey = new Map<string, MediaFragment>();
    const addMedia = (key: string, role: MediaFragment["role"]): void => {
      const normalized = mediaFrom(media.get(key) ?? {}, role);
      if (!normalized) return;
      const existing = mediaByKey.get(key);
      if (!existing || role === "attachment" || role === "article_cover") {
        mediaByKey.set(key, normalized);
      }
    };

    stringList(object(post.attachments)?.media_keys).forEach((key) =>
      addMedia(key, "attachment")
    );
    if (article) {
      const coverKey = string(object(post.article)?.cover_media);
      article.mediaKeys.forEach((key) => addMedia(key, "article"));
      if (coverKey) addMedia(coverKey, "article_cover");
    }
    fragments.push(...mediaByKey.values());

    const relationships: PostRelationship[] = objects(
      post.referenced_posts
    ).flatMap((reference) => {
      const postId = string(reference.id);
      const type = string(reference.type);
      if (!postId || !type) return [];
      const resolved = includedPosts.get(postId);
      const referencedAuthorId = string(resolved?.author_id);
      const referencedAuthor = referencedAuthorId
        ? authorFrom(users.get(referencedAuthorId), referencedAuthorId)
        : undefined;
      const referencedText =
        string(object(resolved?.note_post)?.text) ?? string(resolved?.text);
      const referencedArticle = articleFrom(resolved ?? {});
      const referencedLanguage = string(resolved?.lang);
      const referencedLinks = linksFromEntities(resolved?.entities, "post");
      return [
        {
          type,
          postId,
          url: `https://x.com/i/web/status/${postId}`,
          ...(referencedText ? { text: referencedText } : {}),
          ...(referencedArticle ? { article: referencedArticle } : {}),
          ...(referencedLinks.length ? { links: referencedLinks } : {}),
          ...(referencedLanguage ? { language: referencedLanguage } : {}),
          ...(referencedAuthor ? { author: referencedAuthor } : {}),
        },
      ];
    });
    const createdAt = string(post.created_at);
    const conversationId = string(post.conversation_id);

    return {
      id,
      url: author.username
        ? `https://x.com/${author.username}/status/${id}`
        : `https://x.com/i/web/status/${id}`,
      ...(conversationId ? { conversationId } : {}),
      ...(createdAt ? { createdAt } : {}),
      capturedAt,
      author,
      fragments,
      relationships,
      captureMethods: [captureMethod],
      rawSources: [{ method: captureMethod, snapshot: rawSnapshot, post }],
    };
  });
}

/** Builds a relationship from one raw X post; the caller supplies the edge type. */
function relationshipFrom(
  type: string,
  id: string,
  authorId: string,
  post: JsonObject,
  users: Map<string, JsonObject>,
): PostRelationship {
  const author = authorFrom(users.get(authorId), authorId);
  const text = string(object(post.note_post)?.text) ?? string(post.text);
  const article = articleFrom(post);
  const links = linksFromEntities(post.entities, "post");
  const language = string(post.lang);
  const createdAt = string(post.created_at);
  return {
    type,
    postId: id,
    url: author.username
      ? `https://x.com/${author.username}/status/${id}`
      : `https://x.com/i/web/status/${id}`,
    ...(text ? { text } : {}),
    ...(article ? { article } : {}),
    ...(links.length ? { links } : {}),
    ...(language ? { language } : {}),
    ...(createdAt ? { createdAt } : {}),
    author,
  };
}

export function normalizeThreadResponse(
  input: unknown,
  focalPost: SavedPost,
): PostRelationship[] {
  const response = object(input);
  if (!response || (response.data !== undefined && !Array.isArray(response.data))) {
    throw new Error("Raw X thread response data must be an array when present");
  }
  const users = usersById(response.includes);
  const candidates = objects(response.data)
    .filter((post) => string(post.author_id) === focalPost.author.id)
    .sort(
      (a, b) =>
        (string(a.created_at) ?? "").localeCompare(string(b.created_at) ?? "") ||
        (string(a.id) ?? "").localeCompare(string(b.id) ?? ""),
    );
  const reachable = new Set([focalPost.id]);
  const continuations: PostRelationship[] = [];
  for (const post of candidates) {
    const id = string(post.id);
    const parentId = objects(post.referenced_posts).find(
      (reference) => string(reference.type) === "replied_to",
    );
    if (!id || id === focalPost.id || !reachable.has(string(parentId?.id) ?? "")) {
      continue;
    }
    const authorId = string(post.author_id)!;
    continuations.push(
      relationshipFrom("thread_continuation", id, authorId, post, users),
    );
    reachable.add(id);
    if (continuations.length === 25) break;
  }
  return continuations;
}

export function hasUsableContextPost(input: unknown): boolean {
  const response = object(input);
  const post = object(response?.data);
  const id = string(post?.id);
  const authorId = string(post?.author_id);
  return Boolean(post && id && authorId);
}

export function normalizeContextResponse(input: unknown): PostRelationship {
  const response = object(input);
  const post = object(response?.data);
  const id = string(post?.id);
  const authorId = string(post?.author_id);
  if (!hasUsableContextPost(input) || !post || !id || !authorId) {
    throw new Error("Raw X context response must contain one post and author ID");
  }
  return relationshipFrom(
    "provided_context",
    id,
    authorId,
    post,
    usersById(response?.includes),
  );
}

export function mergeRelationshipContext(
  existing: PostRelationship,
  context: PostRelationship,
): PostRelationship {
  const links = [
    ...(existing.links ?? []),
    ...(context.links ?? []),
  ];
  return {
    ...existing,
    ...context,
    type: existing.type,
    ...(links.length
      ? { links: [...new Map(links.map((link) => [link.url, link])).values()] }
      : {}),
  };
}

export function mergeSavedPosts(posts: SavedPost[]): SavedPost[] {
  const merged = new Map<string, SavedPost>();
  for (const post of posts) {
    const existing = merged.get(post.id);
    if (!existing) {
      merged.set(post.id, post);
      continue;
    }
    existing.captureMethods = [
      ...new Set([...existing.captureMethods, ...post.captureMethods]),
    ];
    existing.rawSources.push(...post.rawSources);
  }
  return [...merged.values()];
}
