# X Likes Ingestion

TypeScript pipeline for capturing liked X posts as unchanged raw JSON, mapping
them into replayable source fragments, and generating experimental Obsidian
preview notes. The real vault is never written by these commands.

## Prerequisites

- Node.js 22.18 or newer
- An approved X developer App with API access and sufficient credits
- Your numeric X user ID
- An OAuth 2.0 user access token for your X account

The token must be authorized with `tweet.read`, `users.read`, and `like.read`.
The app-only Bearer Token from the Developer Console is not accepted by the
liked-posts endpoint; the API requires OAuth 1.0a or OAuth 2.0 User Context.
This client uses OAuth 2.0 because its user access token can be sent directly in
the Bearer header.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

```env
X_BEARER_TOKEN=your_token_here
X_USER_ID=your_numeric_user_id
OPENROUTER_KEY=your_openrouter_key
OPENROUTER_VISION_MODEL=qwen/qwen3-vl-32b-instruct
OPENROUTER_TRANSLATION_MODEL=qwen/qwen3-vl-32b-instruct
OPENROUTER_SYNTHESIS_MODEL=qwen/qwen3-vl-32b-instruct
```

Despite the variable's original name, `X_BEARER_TOKEN` must contain the OAuth
2.0 **user access token**, not the app-only Bearer Token shown separately in the
Developer Console. Do not commit it.

## Fetch one page of likes

```bash
npm run fetch:likes
```

The command requests 10 posts and writes the exact successful response body to:

```text
data/raw/likes-YYYY-MM-DDTHH-mm-ss.json
```

`data/raw/` and `.env` are gitignored because snapshots can contain private or
protected content and tokens are secrets.

## Request details

The client calls:

```text
GET https://api.x.com/2/users/{X_USER_ID}/liked_tweets
```

with these query parameters:

- `max_results=10`
- `post.fields=article,article_title,attachments,author_id,card_uri,community_id,context_annotations,conversation_id,created_at,display_text_range,edit_controls,entities,geo,id,lang,media_metadata,note_post,paid_partnership,possibly_sensitive,public_metrics,reply_settings,source,text,withheld`
- `expansions=article.cover_media,article.media_entities,attachments.media_keys,attachments.media_source_tweet,attachments.poll_ids,author_id,edit_history_post_ids,entities.mentions.username,geo.place_id,in_reply_to_user_id,referenced_posts`
- `user.fields=created_at,description,entities,id,location,name,profile_image_url,protected,public_metrics,url,username,verified,verified_type,withheld`
- `media.fields=alt_text,duration_ms,height,media_key,preview_image_url,public_metrics,type,url,variants,width`
- `poll.fields=duration_minutes,end_datetime,id,options,voting_status`
- `place.fields=contained_within,country,country_code,full_name,geo,id,name,place_type`

The expected top-level response contains a `data` array of posts, optional
expanded objects under `includes` (such as users, media, polls, places, and
referenced posts), pagination information under `meta`, and possibly an
`errors` array for partial failures. The saved raw body is never rewritten;
canonical records are generated separately and retain a pointer to it.

See X's official [Get Users Liked Posts reference](https://docs.x.com/x-api/users/get-liked-posts),
[authentication mapping](https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping),
and [API pricing](https://docs.x.com/x-api/getting-started/pricing).

## Generate an Obsidian preview

Generate deterministic canonical records and Markdown without paid model calls:

```bash
npm run preview
```

Add image understanding, non-English translation, and structured post
synthesis through OpenRouter:

```bash
npm run preview:enrich
```

Outputs are written to:

```text
data/normalized/
data/enrichment/
data/obsidian-preview/
```

These directories are generated, gitignored, and separate from any real
Obsidian vault. OpenRouter responses are cached by model plus post or media ID,
so rerunning the same benchmark does not repeat successful paid calls. Root screenshots are
archived and analyzed. Attached videos up to 10 minutes are archived at a
moderate resolution, sampled into a six-frame contact sheet with `ffmpeg`, and
visually analyzed. Longer videos are not downloaded: `ffmpeg` seeks to six
remote timestamps and only the fixed-size contact sheet is saved. Audio
transcription remains pending. X Article text is rendered directly,
while inline article media remains referenced until reliable placement can be
determined. X's `zxx` label is retained as `source_language` for link-only
wrapper posts and is not applied to the linked article body.

Post synthesis consumes normalized text plus completed translation and visual
extractions. It produces cached, runtime-validated JSON for summaries, topics,
concepts, technologies, people, claims, and relevance. Prompt `v4` excludes
low-level image-extraction uncertainty from whole-post synthesis. Automatic
follow-up generation is deliberately omitted until a note has a concrete user
goal; source-level uncertainty and pending-processing flags remain visible.
Model selection is configurable, and source text is capped at 60,000
characters per post. Earlier prompt caches remain available for comparison.

Generate a read-only vocabulary proposal from the latest canonical snapshot:

```bash
npm run audit:concepts
```

The command makes one cached structured call using the synthesis model and
writes `_Concept Audit.md` beside the preview notes. It proposes at most 30
high-confidence merges, renames, and candidates that should remain plain text.
Unknown, cross-category, duplicate, and otherwise invalid rows are rejected
before rendering. It never changes notes or wikilinks, and every surviving
proposal still requires human approval; an approved alias registry is a
separate later step.

Approved vocabulary decisions live in `config/concepts.json`. Preview
generation applies this registry only while rendering Markdown: aliases are
deduplicated, rejected graph nodes remain plain text, and the original v4
canonical enrichment is preserved unchanged.

## Checks

```bash
npm run check
```

This type-checks the project and runs the small no-network client test.
