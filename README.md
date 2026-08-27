# X Likes Ingestion

TypeScript pipeline for capturing liked X posts as unchanged raw JSON, mapping
them into replayable source fragments, and generating experimental Obsidian
preview notes. The real vault is never written by these commands.

See the [end-to-end pipeline chart](docs/pipeline.md) for the data flow and
command boundaries.

## Prerequisites

- Node.js 22.18 or newer
- An approved X developer App with API access and sufficient credits
- Your numeric X user ID
- An OAuth 2.0 user access token for your X account

The token must be authorized with `tweet.read` and `users.read`, plus
`like.read`, `bookmark.read`, or both depending on the desired sources.
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
X_REFRESH_TOKEN=your_refresh_token
X_CLIENT_ID=your_oauth_2_client_id
X_ARCHIVE_BEARER_TOKEN=your_optional_app_only_bearer_token
OPENROUTER_KEY=your_openrouter_key
OPENROUTER_VISION_MODEL=qwen/qwen3-vl-32b-instruct
OPENROUTER_TRANSLATION_MODEL=qwen/qwen3-vl-32b-instruct
OPENROUTER_SYNTHESIS_MODEL=qwen/qwen3-vl-32b-instruct
OPENROUTER_TRIAGE_MODEL=qwen/qwen3-vl-32b-instruct
OPENROUTER_VERIFICATION_MODEL=openai/gpt-5.6-luna
OPENROUTER_SEARCH_MODEL=openai/gpt-5.6-luna
```

Despite the variable's original name, `X_BEARER_TOKEN` must contain the OAuth
2.0 **user access token**, not the app-only Bearer Token shown separately in the
Developer Console. Do not commit it.

OAuth access tokens expire. With `offline.access` authorized, X also issues a
refresh token; after a `401`, the fetch command uses it once, updates the
ignored `.env` atomically, and retries the request.

Historical same-author thread reconstruction uses X full-archive search, which
rejects OAuth user-context tokens. `X_ARCHIVE_BEARER_TOKEN` is therefore an
optional, separate app-only token; likes and bookmarks continue to use
`X_BEARER_TOKEN`.

## Fetch likes and bookmarks

```bash
npm run fetch:x
npm run fetch:x -- --refresh
```

`--refresh` explicitly replaces a rejected user access token using the saved
OAuth 2.0 refresh token; ordinary `403` responses remain non-refreshing.

Each source is fetched independently, up to 1,000 posts in pages of 100. A
`401` or `403` from one source is reported and skipped, so a token with only
`like.read` or only `bookmark.read` still produces a usable capture. If both
reject the token, the command fails.

Every successful API response is preserved byte-for-byte as its own file:

```text
data/raw/likes-YYYY-MM-DDTHH-mm-ss-page-001.json
data/raw/bookmarks-YYYY-MM-DDTHH-mm-ss-page-001.json
```

`data/raw/` and `.env` are gitignored because snapshots can contain private or
protected content and tokens are secrets.

## Request details

The client calls both:

```text
GET https://api.x.com/2/users/{X_USER_ID}/liked_tweets
GET https://api.x.com/2/users/{X_USER_ID}/bookmarks
```

with these query parameters:

- `max_results=100`
- `pagination_token=...` after the first page, while another page exists
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
canonical records are generated separately and retain pointers to every raw
source. Posts present in both collections are deduplicated by X post ID and
record both `like` and `bookmark` under `capture_methods`.
After a successful fetch, `data/state/sync.json` records a source fingerprint
and capture methods for each current post, reporting new, changed, and
unchanged IDs. The state file is ignored with the rest of `data/`. Synthesis
cache entries also carry a full source fingerprint, so unchanged posts reuse
their existing enrichment while edited posts or newly captured context are
eligible for another synthesis.

## One-command ingestion

For a complete refresh, run:

```bash
npm run ingest
```

This fetches likes and bookmarks, expands posts with explicit thread markers,
retrieves missing reply context, captures up to five external pages per post,
and then builds enriched Obsidian previews. Existing thread, context, and page
captures are reused, so rerunning the command is incremental. Expansion
failures are reported but do not prevent previews for the rest of the batch.

Use `npm run expand` when the X snapshots already exist and only source
expansion is needed. The lower-level `fetch:thread` and `fetch:links` commands
remain available for one-off, explicitly selected captures. Add
`--dry-run` (and optionally `--limit=10`) to inspect the expansion candidates
without making network requests.

For a known multi-post thread, optionally fetch only that conversation's posts
from the focal author:

```bash
npm run fetch:thread -- --post=1496273922714902528
```

This calls `GET https://api.x.com/2/tweets/search/all` for at most 500 self-replies
by the focal author during the following 24 hours and requires
`X_ARCHIVE_BEARER_TOKEN` plus full-archive access. The raw response is saved as
`data/raw/thread-{post_id}-{timestamp}.json`; normalization retains at most 25
same-author replies reachable from the saved post and ignores unrelated posts
and side replies.

When review identifies one exact context post outside that reply chain, attach
it without crawling the surrounding conversation:

```bash
npm run fetch:thread -- --post=1946249533543076159 --context=1946464726109782340
```

After thread/context capture exposes an external article, fetch that post's
captured links explicitly:

```bash
npm run fetch:links -- --post=1948581763154149606
```

This saves the unchanged HTML plus validated readable text under
`data/raw/web/{post_id}/`. It follows at most five public redirects, refuses
local/private addresses and non-HTML responses, stops after 20 seconds or 2 MB,
and fetches at most five links for one explicitly selected post. Captured page
text is then included in normalization, synthesis, and Markdown rendering.

See X's official [Get Users Liked Posts reference](https://docs.x.com/x-api/users/get-liked-posts),
[Get Bookmarks reference](https://docs.x.com/x-api/users/get-bookmarks),
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
npm run preview:enrich -- --post=1528800617233125376
npm run preview:enrich -- --post=1496273922714902528 --refresh-synthesis
```

`--post` enriches one saved post without replacing the full preview index.
`--refresh-synthesis` replaces only its cached whole-post synthesis while
reusing downloaded media, OCR, and translations.
Generated note filenames use underscores instead of spaces for reliable
Obsidian wikilinks; note titles and headings retain their readable spacing.

Outputs are written to:

```text
data/normalized/
data/enrichment/
data/obsidian-preview/
```

These directories are generated, gitignored, and separate from any real
Obsidian vault. Post synthesis is cached by model, prompt, and source
fingerprint, while media extraction is cached by model and media ID, so
rerunning the same or an overlapping snapshot does not repeat successful paid
calls. Media is also archived by media ID; normalization and Markdown
rendering may run again because they are local and deterministic. Root screenshots are
archived and analyzed. Attached videos up to 10 minutes are archived at a
moderate resolution, sampled into a six-frame contact sheet with `ffmpeg`, and
visually analyzed. Longer videos are not downloaded: `ffmpeg` seeks to six
remote timestamps and only the fixed-size contact sheet is saved. Audio
transcription remains pending. X Article text is rendered directly,
captured external HTML is rendered as a linked page,
while inline article media remains referenced until reliable placement can be
determined. X's `zxx` label is retained as `source_language` for link-only
wrapper posts and is not applied to the linked article body.

## Ask the collection

Use the canonical records for natural-language recommendations instead of
asking an LLM to infer identity from Obsidian filenames:

```bash
npm run ask -- "Give me some ideas for improvements in my codebase that would make my work faster"
```

The command searches the latest normalized snapshot, sends compact matching
cards to the configured OpenRouter model, and prints actionable ideas with
links back to the supporting X posts. It does not perform web search and does
not change the vault. Lexical matches are ranked first, with recent fallback
cards retained so semantic recommendations are not limited to exact query
words. `--limit=120` increases the number of candidate posts sent
to the model. Set `OPENROUTER_QUERY_MODEL` to choose the query model; it falls
back to `OPENROUTER_SYNTHESIS_MODEL`.

Run an optional, cached relevance triage without web search:

```bash
npm run triage:relevance
npm run triage:relevance -- --limit=20
npm run triage:relevance -- --post=1496273922714902528 --refresh
```

It classifies posts as `durable`, `time_sensitive`, `non_knowledge`, or `unclear`
and writes diagnostic `_Relevance_Triage.md`, processing the oldest posts first. It never
deletes or hides content. Only
`time_sensitive` items receive a suggested query; no web search is performed
by this command. Attached media does not make otherwise useful text unclear;
missing media or links only prevent a `non_knowledge` verdict.
Reviewed post-specific decisions live in `config/relevance.json` and override
cached model triage without changing or deleting source material.

Verify those candidates using OpenRouter web search:

```bash
npm run verify:relevance
npm run verify:relevance -- --report-only
npm run verify:relevance -- --limit=3
npm run verify:relevance -- --post=1500196959235227648 --refresh-evidence
```

Search evidence and classifications are cached separately, so changing
`OPENROUTER_VERIFICATION_MODEL` reuses the same searches. Detailed results are
written to diagnostic `_Relevance_Verification.md`; `_Relevance_Audit.md` is
the authoritative combined view in which verification replaces preliminary
triage labels. Reports include up to three selected source links. Factual
verdicts without citations are rejected. Opinion is kept
separate from `current`/`superseded`, and this step also never deletes content.
`--report-only` reuses existing dated caches and makes no OpenRouter calls.

Post synthesis consumes normalized text plus completed translation and visual
extractions. It produces cached, runtime-validated JSON for summaries, topics,
concepts, technologies, people, claims, and relevance. Prompt `v5` keeps X
link-wrapper commentary out of claims and excludes low-level image-extraction
uncertainty from whole-post synthesis. Automatic
follow-up generation is deliberately omitted until a note has a concrete user
goal; source-level uncertainty and pending-processing flags remain visible.
Model selection is configurable, and source text is capped at 60,000
characters per post. Earlier prompt caches remain available for comparison.

Generate a read-only vocabulary proposal from the latest canonical snapshot:

```bash
npm run audit:concepts
```

The command makes one cached structured call using the synthesis model and
writes `_Concept_Audit.md` beside the preview notes. It proposes at most 30
high-confidence merges, renames, and candidates that should remain plain text.
Unknown, cross-category, duplicate, and otherwise invalid rows are rejected
before rendering. It never changes notes or wikilinks, and every surviving
proposal still requires human approval; an approved alias registry is a
separate later step.

Approved vocabulary decisions live in `config/concepts.json`. Preview
generation applies this registry only while rendering Markdown: aliases are
deduplicated, rejected graph nodes remain plain text, and the original v4
canonical enrichment is preserved unchanged. Topic comparison is
case-insensitive: ordinary words render lowercase while uppercase acronyms are
preserved, so `AI Agents` and `AI agents` become one `AI agents` topic.

## Checks

```bash
npm run check
```

This type-checks the project and runs the small no-network client test.
