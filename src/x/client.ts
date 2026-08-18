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

export interface FetchLikedPostsOptions {
  bearerToken: string;
  userId: string;
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

export function buildLikedPostsUrl(
  userId: string,
  maxResults = 10,
): URL {
  if (!/^\d{1,19}$/.test(userId)) {
    throw new Error("X_USER_ID must contain 1-19 digits");
  }

  if (!Number.isInteger(maxResults) || maxResults < 5 || maxResults > 100) {
    throw new Error("maxResults must be an integer from 5 to 100");
  }

  const url = new URL(`${API_BASE_URL}/users/${userId}/liked_tweets`);
  url.searchParams.set("max_results", String(maxResults));
  url.searchParams.set("post.fields", POST_FIELDS.join(","));
  url.searchParams.set("expansions", EXPANSIONS.join(","));
  url.searchParams.set("user.fields", USER_FIELDS.join(","));
  url.searchParams.set("media.fields", MEDIA_FIELDS.join(","));
  url.searchParams.set("poll.fields", POLL_FIELDS.join(","));
  url.searchParams.set("place.fields", PLACE_FIELDS.join(","));
  return url;
}

export async function fetchLikedPostsRaw({
  bearerToken,
  userId,
  maxResults = 10,
}: FetchLikedPostsOptions): Promise<string> {
  const response = await fetch(buildLikedPostsUrl(userId, maxResults), {
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
