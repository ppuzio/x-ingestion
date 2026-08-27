import type {
  ArticleFragment,
  LinkFragment,
  MediaFragment,
  SavedPost,
  TextFragment,
  WebPageFragment,
} from "../model.ts";
import { collapseWhitespace, stripUrls } from "../text.ts";
import { sourceGapsForPost } from "../x/expand.ts";

export interface ConceptVocabulary {
  aliases: {
    topic: Record<string, string>;
    concept: Record<string, string>;
  };
  plainText: { concept: string[] };
}

function textFragment(post: SavedPost): TextFragment {
  const fragment = post.fragments.find(
    (candidate): candidate is TextFragment => candidate.kind === "text",
  );
  if (!fragment) throw new Error(`Post ${post.id} has no text fragment`);
  return fragment;
}

/** Obsidian and the filesystem both reject these in a note name or wikilink. */
function safeName(value: string): string {
  return collapseWhitespace(value.replace(/[/\\:*?"<>|#[\]^]/g, "-"));
}

function markdownText(value: string): string {
  return value.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function titleFor(post: SavedPost): string {
  const article = post.fragments.find(
    (fragment): fragment is ArticleFragment => fragment.kind === "article",
  );
  const webPage = post.fragments.find(
    (fragment): fragment is WebPageFragment => fragment.kind === "web_page",
  );
  const line =
    article?.title ??
    webPage?.title ??
    textFragment(post)
      .text.split("\n")
      .map((value) => stripUrls(value).trim())
      .find(Boolean);
  return collapseWhitespace(
    line || `X post by ${post.author.username ?? post.author.id}`,
  ).slice(0, 100);
}

function filenameFor(title: string, id: string): string {
  const filenamePart = (value: string, limit = Number.POSITIVE_INFINITY) => {
    // Quotes drop out so "author's" reads as "authors"; everything else outside
    // the allowlist — including every character safeName guards — collapses to
    // one underscore.
    const sanitized = value
      .replace(/[\u0060\u0027\u2019]/g, "")
      .replace(/[^\p{L}\p{N}_.-]+/gu, "_");
    return sanitized.slice(0, limit).replace(/_+$/g, "");
  };
  return `${filenamePart(title, 90) || "X_post"}--${filenamePart(id)}.md`;
}

function list(values: string[]): string[] {
  return values.length
    ? values.map((value) => `- ${markdownText(collapseWhitespace(value))}`)
    : ["- None"];
}

function wikilinks(values: string[]): string[] {
  return list(values.map((value) => `[[${safeName(value)}]]`));
}

export function normalizeTopicCase(value: string): string {
  return vocabularyKey(value);
}

export function vocabularyKey(value: string): string {
  return collapseWhitespace(value).toLocaleLowerCase();
}

export function canonicalizeVocabularyName(
  value: string,
  aliases: Record<string, string>,
): string {
  const key = vocabularyKey(value);
  return aliases[value] ?? Object.entries(aliases).find(
    ([alias]) => vocabularyKey(alias) === key,
  )?.[1] ?? value;
}

export function canonicalizeTopic(
  value: string,
  aliases: Record<string, string>,
): string {
  return normalizeTopicCase(canonicalizeVocabularyName(value, aliases));
}

export function canonicalizeConcept(
  value: string,
  aliases: Record<string, string>,
): string {
  return vocabularyKey(canonicalizeVocabularyName(value, aliases));
}

function canonicalizeTopics(
  values: string[],
  aliases: Record<string, string>,
): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const canonical = canonicalizeTopic(value, aliases);
    const key = vocabularyKey(canonical);
    if (seen.has(key)) return [];
    seen.add(key);
    return [canonical];
  });
}

function renderConcepts(values: string[], vocabulary?: ConceptVocabulary): string[] {
  const aliases = vocabulary?.aliases.concept ?? {};
  const plainText = new Set(
    (vocabulary?.plainText.concept ?? []).map(vocabularyKey),
  );
  const seen = new Set<string>();
  const rendered: string[] = [];
  for (const original of values) {
    const canonical = canonicalizeConcept(original, aliases);
    const key = vocabularyKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    rendered.push(
      plainText.has(vocabularyKey(original)) || plainText.has(key)
        ? canonical
        : `[[${safeName(canonical)}]]`,
    );
  }
  return list(rendered);
}

function renderMedia(media: MediaFragment, index: number): string[] {
  const label =
    media.mediaType === "image"
      ? "Image"
      : media.mediaType === "video"
        ? "Video"
        : "Animated GIF";
  const lines = [`### ${label} ${index + 1}`];
  if (media.assetPath) lines.push("", `![[${media.assetPath}]]`);
  if (media.contactSheetPath) {
    lines.push("", "#### Sampled frames", "", `![[${media.contactSheetPath}]]`);
  }
  if (media.archived === false) {
    lines.push(
      "",
      media.contactSheetPath
        ? "_Full video not archived; frames were sampled remotely._"
        : "_Full video not archived._",
    );
  }
  if (media.url) lines.push("", `[Open original media](${media.url})`);
  if (media.altText) lines.push("", `Alt text: ${markdownText(media.altText)}`);
  if (media.extraction) {
    lines.push(
      "",
      "#### Visual interpretation",
      "",
      markdownText(media.extraction.visualSummary),
      "",
      "#### Key facts",
      "",
      ...list(media.extraction.keyFacts),
    );
    if (media.extraction.verbatimText) {
      lines.push(
        "",
        `#### Extracted text (${media.extraction.language ?? "unknown language"})`,
        "",
        "````text",
        media.extraction.verbatimText,
        "````",
      );
    }
    if (media.extraction.uncertainties.length) {
      lines.push(
        "",
        "#### Extraction uncertainties",
        "",
        ...list(media.extraction.uncertainties),
      );
    }
  } else if (media.mediaType === "image" && media.role === "attachment") {
    lines.push("", "_Vision extraction pending._");
  } else if (media.mediaType !== "image") {
    lines.push("", "_Frame analysis pending._");
  }
  if (media.mediaType !== "image") {
    lines.push("", "_Audio transcription pending._");
  }
  return lines;
}

export function renderObsidianNote(post: SavedPost, vocabulary?: ConceptVocabulary): {
  filename: string;
  title: string;
  markdown: string;
} {
  const text = textFragment(post);
  const title = titleFor(post);
  const articles = post.fragments.filter(
    (fragment): fragment is ArticleFragment => fragment.kind === "article",
  );
  const media = post.fragments.filter(
    (fragment): fragment is MediaFragment => fragment.kind === "media",
  );
  const links = post.fragments.filter(
    (fragment): fragment is LinkFragment => fragment.kind === "link",
  );
  const webPages = post.fragments.filter(
    (fragment): fragment is WebPageFragment => fragment.kind === "web_page",
  );
  const contentTypes = [
    "text",
    ...articles.map(() => "article"),
    ...webPages.map(() => "web_page"),
    ...media.map((item) => item.mediaType),
    ...post.relationships.map((item) => item.type),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const needsTranslation = Boolean(
    text.language && !["en", "und", "zxx"].includes(text.language) && !text.translation,
  );
  const needsVision = media.some(
    (item) => item.role === "attachment" && !item.extraction,
  );
  const needsTranscription = media.some(
    (item) => item.role !== "article" && item.mediaType !== "image",
  );
  const videos = media.filter(
    (item) => item.role !== "article" && item.mediaType !== "image",
  );
  const enrichment = post.enrichment;
  const sourceGaps = sourceGapsForPost(post);
  const topics = enrichment
    ? canonicalizeTopics(enrichment.topics, vocabulary?.aliases.topic ?? {})
    : [];
  const lines = [
    "---",
    "type: x-capture",
    "source: x",
    `post_id: ${JSON.stringify(post.id)}`,
    `source_url: ${JSON.stringify(post.url)}`,
    `author_id: ${JSON.stringify(post.author.id)}`,
    ...(post.author.username
      ? [`author: ${JSON.stringify(`@${post.author.username}`)}`]
      : []),
    ...(post.createdAt ? [`created: ${JSON.stringify(post.createdAt)}`] : []),
    `captured: ${JSON.stringify(post.capturedAt)}`,
    "capture_methods:",
    ...post.captureMethods.map((method) => `  - ${method}`),
    ...(text.language && !["und", "zxx"].includes(text.language)
      ? [`language: ${JSON.stringify(text.language)}`]
      : text.language
        ? [`source_language: ${JSON.stringify(text.language)}`]
        : []),
    "content_types:",
    ...contentTypes.map((value) => `  - ${value}`),
    `needs_translation: ${needsTranslation}`,
    `needs_vision: ${needsVision}`,
    `needs_transcription: ${needsTranscription}`,
    ...(videos.length
      ? [`video_archived: ${videos.every((item) => item.archived === true)}`]
      : []),
    `needs_synthesis: ${!enrichment}`,
    ...(sourceGaps.length
      ? ["source_gaps:", ...sourceGaps.map(({ kind }) => `  - ${kind}`)]
      : []),
    ...(post.relevance
      ? [`relevance_status: ${JSON.stringify(post.relevance.verdict)}`]
      : []),
    ...(topics.length
      ? ["topics:", ...topics.map((value) => `  - ${JSON.stringify(value)}`)]
      : []),
    "status: unread",
    "---",
    "",
    `# ${markdownText(title)}`,
    "",
    `Source: [${post.author.username ? `@${post.author.username}` : "X post"}](${post.url})`,
    "",
    text.language === "zxx"
      ? "## Source post (no linguistic content)"
      : `## Original${text.language ? ` (${text.language})` : ""}`,
    "",
    markdownText(text.text),
  ];

  if (text.translation) {
    lines.push(
      "",
      "## English translation",
      "",
      markdownText(text.translation.translatedText),
    );
  }

  for (const article of articles) {
    lines.push(
      "",
      `## Article: ${markdownText(article.title)}`,
      "",
      markdownText(article.text),
    );
    if (article.codeBlocks.length) {
      lines.push("", "### Article code blocks");
      for (const block of article.codeBlocks) {
        lines.push("", `\`\`\`\`${block.language ?? ""}`, block.code, "````");
      }
    }
    const inlineMediaCount = media.filter((item) => item.role === "article").length;
    if (inlineMediaCount) {
      lines.push(
        "",
        `_${inlineMediaCount} inline article media item(s) are preserved in the canonical record but not placed because X does not expose reliable positions._`,
      );
    }
  }

  for (const page of webPages) {
    lines.push(
      "",
      `## Linked page: ${markdownText(page.title)}`,
      "",
      `[Open linked page](${page.url})`,
      ...(page.byline ? ["", `By ${page.byline}`] : []),
      "",
      markdownText(page.text),
    );
  }

  const visibleMedia = media.filter((item) => item.role !== "article");
  if (visibleMedia.length) {
    lines.push("", "## Media");
    visibleMedia.forEach((item, index) => lines.push("", ...renderMedia(item, index)));
  }

  if (post.relationships.length) {
    lines.push("", "## Referenced posts");
    for (const relationship of post.relationships) {
      lines.push(
        "",
        `### ${relationship.type.replaceAll("_", " ")}`,
        "",
        `[Open referenced post](${relationship.url})`,
        ...(relationship.text ? ["", markdownText(relationship.text)] : []),
        ...(relationship.article
          ? [
              "",
              `#### Article: ${markdownText(relationship.article.title)}`,
              "",
              markdownText(relationship.article.text),
              ...(relationship.article.codeBlocks.length
                ? [
                    "",
                    "##### Article code blocks",
                    ...relationship.article.codeBlocks.flatMap((block) => [
                      "",
                      `\`\`\`\`${block.language ?? ""}`,
                      block.code,
                      "````",
                    ]),
                  ]
                : []),
            ]
          : []),
        ...(relationship.links?.length
          ? [
              "",
              ...relationship.links.map(
                (link) =>
                  `- [${(link.title ?? link.url).replaceAll("]", "\\]")}](${link.url})`,
              ),
            ]
          : []),
      );
    }
  }

  if (links.length) {
    lines.push(
      "",
      "## External links",
      "",
      ...links.map(
        (link) => `- [${(link.title ?? link.url).replaceAll("]", "\\]")}](${link.url})`,
      ),
    );
  }

  if (sourceGaps.length) {
    lines.push("", "## Source gaps", "", ...sourceGaps.map(({ message }) => `- ${message}`));
  }

  lines.push(
    "",
    "## Summary",
    "",
    enrichment ? markdownText(enrichment.summary) : "_Pending synthesis._",
  );

  if (post.relevance) {
    lines.push(
      "",
      "## Freshness",
      "",
      `**${post.relevance.verdict.replaceAll("_", " ")}** — ${markdownText(post.relevance.reason)}`,
      "",
      `Current guidance: ${markdownText(post.relevance.currentGuidance)}`,
      ...(post.relevance.evidenceUrls.length
        ? [
            "",
            ...post.relevance.evidenceUrls.map((url) => `- [Evidence](${url})`),
          ]
        : []),
    );
  }

  if (enrichment) {
    lines.push(
      "",
      "## Concepts",
      "",
      ...renderConcepts(enrichment.concepts, vocabulary),
      "",
      "## Technologies",
      "",
      ...wikilinks(enrichment.technologies),
      "",
      "## People",
      "",
      ...wikilinks(enrichment.people),
      "",
      "## Claims",
      "",
      ...list(enrichment.claims),
      "",
      "## Why revisit",
      "",
      markdownText(enrichment.relevance),
    );
  } else {
    lines.push("", "## Concepts", "", "_Pending synthesis._");
  }

  lines.push(
    "",
    "## Provenance",
    "",
    ...post.rawSources.map(
      (source) => `- Raw ${source.method}: \`${source.snapshot}\``,
    ),
    ...media.flatMap((item) =>
      item.extraction ? [`- Vision model for ${item.mediaKey}: \`${item.extraction.model}\``] : [],
    ),
    ...videos.flatMap((item) =>
      item.archived === false
        ? [`- Video ${item.mediaKey}: contact sheet only; source media not archived`]
        : [],
    ),
    ...(text.translation ? [`- Translation model: \`${text.translation.model}\``] : []),
    ...(enrichment
      ? [
          `- Synthesis model: \`${enrichment.model}\``,
          `- Synthesis prompt: \`${enrichment.promptVersion}\``,
          ...(vocabulary ? ["- Concept vocabulary: `config/concepts.json`"] : []),
        ]
      : []),
    "",
  );

  return { filename: filenameFor(title, post.id), title, markdown: lines.join("\n") };
}
