import type {
  ArticleFragment,
  ContentFragment,
  LinkFragment,
  MediaFragment,
  PostRelationship,
  SavedAuthor,
  SavedPost,
} from "../model.ts";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(object).filter((item): item is JsonObject => item !== undefined)
    : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => string(item) ?? [])
    : [];
}

function authorFrom(user: JsonObject | undefined, id: string): SavedAuthor {
  const username = string(user?.username);
  const name = string(user?.name);
  return {
    id,
    ...(username ? { username } : {}),
    ...(name ? { name } : {}),
  };
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
    mediaKeys: strings(article.media_entities),
  };
}

const VARIANTS_BIT_RATE = 1_500_000;

function mediaFrom(
  media: JsonObject,
  role: MediaFragment["role"]
): MediaFragment | undefined {
  const mediaKey = string(media.media_key);
  const xType = string(media.type);
  if (!mediaKey || !xType) return undefined;

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
  capturedAt: string
): SavedPost[] {
  const response = object(input);
  if (!response || !Array.isArray(response.data)) {
    throw new Error("Raw X response must contain a data array");
  }

  const includes = object(response.includes);
  const includedPosts = new Map(
    objects(includes?.posts).flatMap((post) => {
      const id = string(post.id);
      return id ? [[id, post] as const] : [];
    })
  );
  const users = new Map(
    objects(includes?.users).flatMap((user) => {
      const id = string(user.id);
      return id ? [[id, user] as const] : [];
    })
  );
  const media = new Map(
    objects(includes?.media).flatMap((item) => {
      const key = string(item.media_key);
      return key ? [[key, item] as const] : [];
    })
  );

  return response.data.map((item, index) => {
    const post = object(item);
    const id = string(post?.id);
    const rootText = string(post?.text);
    const authorId = string(post?.author_id);
    if (!post || !id || rootText === undefined || !authorId) {
      throw new Error(`Invalid X post at data[${index}]`);
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

    strings(object(post.attachments)?.media_keys).forEach((key) =>
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
      const referencedLanguage = string(resolved?.lang);
      return [
        {
          type,
          postId,
          url: `https://x.com/i/web/status/${postId}`,
          ...(referencedText ? { text: referencedText } : {}),
          ...(referencedLanguage ? { language: referencedLanguage } : {}),
          ...(referencedAuthor ? { author: referencedAuthor } : {}),
        },
      ];
    });
    const createdAt = string(post.created_at);

    return {
      id,
      url: author.username
        ? `https://x.com/${author.username}/status/${id}`
        : `https://x.com/i/web/status/${id}`,
      ...(createdAt ? { createdAt } : {}),
      capturedAt,
      author,
      fragments,
      relationships,
      rawSnapshot,
      raw: post,
    };
  });
}
