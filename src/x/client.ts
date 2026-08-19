const API_BASE_URL = "https://api.x.com/2";

const POST_FIELDS = [
  "article",
  "article_title",
  "attachments",
  "author_id",
  "card_uri",
  "community_id",
  "context_annotations",
  "conversation_id",
  "created_at",
  "display_text_range",
  "edit_controls",
  "entities",
  "geo",
  "id",
  "lang",
  "media_metadata",
  "note_post",
  "paid_partnership",
  "possibly_sensitive",
  "public_metrics",
  "reply_settings",
  "source",
  "text",
  "withheld",
];

const EXPANSIONS = [
  "article.cover_media",
  "article.media_entities",
  "attachments.media_keys",
  "attachments.media_source_tweet",
  "attachments.poll_ids",
  "author_id",
  "edit_history_post_ids",
  "entities.mentions.username",
  "geo.place_id",
  "in_reply_to_user_id",
  "referenced_posts",
];

const USER_FIELDS = [
  "created_at",
  "description",
  "entities",
  "id",
  "location",
  "name",
  "profile_image_url",
  "protected",
  "public_metrics",
  "url",
  "username",
  "verified",
  "verified_type",
  "withheld",
];

const MEDIA_FIELDS = [
  "alt_text",
  "duration_ms",
  "height",
  "media_key",
  "preview_image_url",
  "public_metrics",
  "type",
  "url",
  "variants",
  "width",
];

const POLL_FIELDS = [
  "duration_minutes",
  "end_datetime",
  "id",
  "options",
  "voting_status",
];

const PLACE_FIELDS = [
  "contained_within",
  "country",
  "country_code",
  "full_name",
  "geo",
  "id",
  "name",
  "place_type",
];

export type XCollection = "likes" | "bookmarks";

export interface FetchUserPostsOptions {
  bearerToken: string;
  userId: string;
  collection: XCollection;
  maxResults?: number;
  paginationToken?: string;
}

export interface FetchConversationOptions {
  bearerToken: string;
  conversationId: string;
  username: string;
  createdAt: string;
  maxResults?: number;
}

export class XApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function refreshXUserToken(
  refreshToken: string,
  clientId: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await fetch(`${API_BASE_URL}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      client_id: clientId,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new XApiError(
      response.status,
      `X OAuth token refresh failed (${response.status} ${response.statusText}): ${body}`,
    );
  }

  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (typeof parsed.access_token !== "string") {
    throw new Error("X OAuth token refresh response did not contain an access token");
  }
  return {
    accessToken: parsed.access_token,
    refreshToken:
      typeof parsed.refresh_token === "string"
        ? parsed.refresh_token
        : refreshToken,
  };
}

export function buildUserPostsUrl(
  userId: string,
  collection: XCollection,
  maxResults = 10,
  paginationToken?: string,
): URL {
  if (!/^\d{1,19}$/.test(userId)) {
    throw new Error("X_USER_ID must contain 1-19 digits");
  }

  const minimum = collection === "likes" ? 5 : 1;
  if (!Number.isInteger(maxResults) || maxResults < minimum || maxResults > 100) {
    throw new Error(`maxResults must be an integer from ${minimum} to 100`);
  }

  const endpoint = collection === "likes" ? "liked_tweets" : "bookmarks";
  const url = new URL(`${API_BASE_URL}/users/${userId}/${endpoint}`);
  url.searchParams.set("max_results", String(maxResults));
  if (paginationToken) url.searchParams.set("pagination_token", paginationToken);
  setPostParameters(url);
  return url;
}

function setPostParameters(url: URL): void {
  url.searchParams.set("post.fields", POST_FIELDS.join(","));
  url.searchParams.set("expansions", EXPANSIONS.join(","));
  url.searchParams.set("user.fields", USER_FIELDS.join(","));
  url.searchParams.set("media.fields", MEDIA_FIELDS.join(","));
  url.searchParams.set("poll.fields", POLL_FIELDS.join(","));
  url.searchParams.set("place.fields", PLACE_FIELDS.join(","));
}

export function buildConversationSearchUrl(
  conversationId: string,
  username: string,
  createdAt: string,
  maxResults = 500,
): URL {
  if (!/^\d{1,19}$/.test(conversationId)) {
    throw new Error("X conversation ID must contain 1-19 digits");
  }
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
    throw new Error("X username must contain 1-15 letters, digits, or underscores");
  }
  const start = new Date(createdAt);
  if (Number.isNaN(start.valueOf())) throw new Error("X post creation time is invalid");
  if (!Number.isInteger(maxResults) || maxResults < 10 || maxResults > 500) {
    throw new Error("maxResults must be an integer from 10 to 500");
  }
  const url = new URL(`${API_BASE_URL}/tweets/search/all`);
  // ponytail: seven days and 500 author posts bound cost; paginate only if a
  // reviewed thread proves this misses continuations from an unusually active author.
  url.searchParams.set("query", `from:${username}`);
  url.searchParams.set("start_time", new Date(start.valueOf() - 1_000).toISOString());
  url.searchParams.set(
    "end_time",
    new Date(start.valueOf() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
  );
  url.searchParams.set("max_results", String(maxResults));
  setPostParameters(url);
  return url;
}

async function fetchRaw(url: URL, bearerToken: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${bearerToken}`,
    },
  });
  const body = await response.text();

  if (!response.ok) {
    throw new XApiError(
      response.status,
      `X API request failed (${response.status} ${response.statusText}): ${body}`,
    );
  }

  try {
    JSON.parse(body);
  } catch {
    throw new Error("X API returned a successful response that was not valid JSON");
  }
  return body;
}

export async function fetchUserPostsRaw({
  bearerToken,
  userId,
  collection,
  maxResults = 100,
  paginationToken,
}: FetchUserPostsOptions): Promise<string> {
  return fetchRaw(
    buildUserPostsUrl(userId, collection, maxResults, paginationToken),
    bearerToken,
  );
}

export async function fetchConversationRaw({
  bearerToken,
  conversationId,
  username,
  createdAt,
  maxResults = 500,
}: FetchConversationOptions): Promise<string> {
  return fetchRaw(
    buildConversationSearchUrl(conversationId, username, createdAt, maxResults),
    bearerToken,
  );
}
