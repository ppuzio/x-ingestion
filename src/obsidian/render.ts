import type {
  ArticleFragment,
  LinkFragment,
  MediaFragment,
  SavedPost,
  TextFragment,
} from "../model.ts";
import { collapseWhitespace, stripUrls } from "../text.ts";

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

function titleFor(post: SavedPost): string {
  const article = post.fragments.find(
    (fragment): fragment is ArticleFragment => fragment.kind === "article",
  );
  const line =
    article?.title ??
    textFragment(post)
      .text.split("\n")
      .map((value) => stripUrls(value).trim())
      .find(Boolean);
  return collapseWhitespace(
    line || `X post by ${post.author.username ?? post.author.id}`,
  ).slice(0, 100);
}

function filenameFor(title: string, id: string): string {
  return `${safeName(title).slice(0, 90) || "X post"} -- ${safeName(id)}.md`;
}

function list(values: string[]): string[] {
  return values.length
    ? values.map((value) => `- ${collapseWhitespace(value)}`)
    : ["- None"];
}

function wikilinks(values: string[]): string[] {
  return list(values.map((value) => `[[${safeName(value)}]]`));
}

export function normalizeTopicCase(value: string): string {
  return collapseWhitespace(value)
    .split(" ")
    .map((word) =>
      /[A-Z]/.test(word) && word === word.toUpperCase()
        ? word
        : word.toLowerCase(),
    )
    .join(" ");
}

function canonicalizeTopics(
  values: string[],
  aliases: Record<string, string>,
): string[] {
  return [
    ...new Set(
      values.map((value) => normalizeTopicCase(aliases[value] ?? value)),
    ),
  ];
}

function renderConcepts(values: string[], vocabulary?: ConceptVocabulary): string[] {
  const aliases = vocabulary?.aliases.concept ?? {};
  const plainText = new Set(vocabulary?.plainText.concept ?? []);
  const seen = new Set<string>();
  const rendered: string[] = [];
  for (const original of values) {
    const canonical = aliases[original] ?? original;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    rendered.push(
      plainText.has(original) || plainText.has(canonical)
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
  if (media.altText) lines.push("", `Alt text: ${media.altText}`);
  if (media.extraction) {
    lines.push(
      "",
      "#### Visual interpretation",
      "",
      media.extraction.visualSummary,
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
  const contentTypes = [
    "text",
    ...articles.map(() => "article"),
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
    ...(topics.length
      ? ["topics:", ...topics.map((value) => `  - ${JSON.stringify(value)}`)]
      : []),
    "status: unread",
    "---",
    "",
    `# ${title}`,
    "",
    `Source: [${post.author.username ? `@${post.author.username}` : "X post"}](${post.url})`,
    "",
    text.language === "zxx"
      ? "## Source post (no linguistic content)"
      : `## Original${text.language ? ` (${text.language})` : ""}`,
    "",
    text.text,
  ];

  if (text.translation) {
    lines.push("", "## English translation", "", text.translation.translatedText);
  }

  for (const article of articles) {
    lines.push("", `## Article: ${article.title}`, "", article.text);
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
        ...(relationship.text ? ["", relationship.text] : []),
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

  lines.push("", "## Summary", "", enrichment?.summary ?? "_Pending synthesis._");

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
      enrichment.relevance,
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
