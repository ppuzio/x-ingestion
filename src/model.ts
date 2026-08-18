export interface SavedAuthor {
  id: string;
  username?: string;
  name?: string;
}

export type CaptureMethod = "like" | "bookmark";

export interface RawSource {
  method: CaptureMethod;
  snapshot: string;
  post: unknown;
}

export interface Translation {
  sourceLanguage: string;
  targetLanguage: "en";
  translatedText: string;
  model: string;
}

export interface ImageExtraction {
  kind: "screenshot" | "diagram" | "photo" | "document" | "other";
  language: string | null;
  verbatimText: string;
  visualSummary: string;
  keyFacts: string[];
  uncertainties: string[];
  model: string;
}

export interface PostEnrichment {
  summary: string;
  topics: string[];
  concepts: string[];
  technologies: string[];
  people: string[];
  claims: string[];
  relevance: string;
  model: string;
  promptVersion: string;
}

export interface TextFragment {
  kind: "text";
  source: "post" | "note";
  text: string;
  language?: string;
  translation?: Translation;
}

export interface ArticleFragment {
  kind: "article";
  title: string;
  text: string;
  codeBlocks: Array<{ language?: string; code: string }>;
  mediaKeys: string[];
}

export interface MediaFragment {
  kind: "media";
  mediaKey: string;
  mediaType: "image" | "video" | "animated_gif";
  role: "attachment" | "article_cover" | "article";
  url?: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
  assetPath?: string;
  contactSheetPath?: string;
  archived?: boolean;
  extraction?: ImageExtraction;
}

export const MAX_ARCHIVED_VIDEO_DURATION_MS = 10 * 60 * 1_000;

export function shouldArchiveVideo(durationMs: number): boolean {
  return durationMs > 0 && durationMs <= MAX_ARCHIVED_VIDEO_DURATION_MS;
}

export interface LinkFragment {
  kind: "link";
  source: "post" | "article";
  url: string;
  title?: string;
}

export type ContentFragment =
  | TextFragment
  | ArticleFragment
  | MediaFragment
  | LinkFragment;

export interface PostRelationship {
  type: string;
  postId: string;
  url: string;
  text?: string;
  language?: string;
  author?: SavedAuthor;
}

export interface SavedPost {
  id: string;
  url: string;
  createdAt?: string;
  capturedAt: string;
  author: SavedAuthor;
  fragments: ContentFragment[];
  relationships: PostRelationship[];
  enrichment?: PostEnrichment;
  captureMethods: CaptureMethod[];
  rawSources: RawSource[];
}
