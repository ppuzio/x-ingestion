import { object, strings, type JsonObject } from "../json.ts";
import type { ImageExtraction, Translation } from "../model.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_TIMEOUT_MS = 2 * 60 * 1_000;

export interface StructuredJsonOptions {
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high" | "max";
  timeoutMs?: number;
}

export interface UrlCitation {
  url: string;
  title?: string;
  content?: string;
}

export function parseUrlCitations(value: unknown): UrlCitation[] {
  if (!Array.isArray(value)) return [];
  const citations = value.flatMap((item) => {
    const citation = object(object(item)?.url_citation);
    const url = citation?.url;
    const title = citation?.title;
    const content = citation?.content;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return [];
    return [{
      url,
      ...(typeof title === "string" && title.trim() ? { title } : {}),
      ...(typeof content === "string" && content.trim()
        ? { content: content.slice(0, 2_000) }
        : {}),
    }];
  });
  return [...new Map(citations.map((citation) => [citation.url, citation])).values()];
}

async function requestOpenRouter(
  apiKey: string,
  body: JsonObject,
  timeoutMs = OPENROUTER_TIMEOUT_MS,
): Promise<unknown> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenRouter request failed (${response.status} ${response.statusText}): ${rawText}`,
    );
  }
  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error("OpenRouter returned invalid JSON");
  }
}

function responseMessage(rawResponse: unknown): JsonObject | undefined {
  const choices = object(rawResponse)?.choices;
  return Array.isArray(choices) ? object(object(choices[0])?.message) : undefined;
}

function modelOptions(
  model: string,
  reasoningEffort?: StructuredJsonOptions["reasoningEffort"],
): JsonObject {
  return model.startsWith("openai/gpt-5")
    ? { reasoning: { effort: reasoningEffort ?? "max" } }
    : { temperature: 0 };
}

export async function requestStructuredJson(
  apiKey: string,
  model: string,
  content: unknown[],
  schemaName: string,
  schema: JsonObject,
  options: StructuredJsonOptions = {},
): Promise<{ parsed: unknown; rawResponse: unknown; citations: UrlCitation[] }> {
  const rawResponse = await requestOpenRouter(apiKey, {
    model,
    ...modelOptions(model, options.reasoningEffort),
    max_tokens: options.maxTokens ?? 16_000,
    messages: [{ role: "user", content }],
    response_format: {
      type: "json_schema",
      json_schema: { name: schemaName, strict: true, schema },
    },
    provider: { require_parameters: true },
  }, options.timeoutMs);
  const message = responseMessage(rawResponse);
  const messageContent = message?.content;
  if (typeof messageContent !== "string") {
    throw new Error("OpenRouter response did not contain textual JSON output");
  }

  try {
    return {
      parsed: JSON.parse(messageContent),
      rawResponse,
      citations: parseUrlCitations(message?.annotations),
    };
  } catch {
    throw new Error("OpenRouter model output was not valid JSON");
  }
}

export async function requestWebSearch(
  apiKey: string,
  model: string,
  content: unknown[],
): Promise<{ text: string; citations: UrlCitation[]; rawResponse: unknown }> {
  const rawResponse = await requestOpenRouter(apiKey, {
    model,
    ...modelOptions(model),
    max_tokens: 12_000,
    messages: [{ role: "user", content }],
    tools: [
      {
        type: "openrouter:web_search",
        parameters: { engine: "parallel", mode: "fast", max_results: 5 },
      },
    ],
    max_tool_calls: 1,
    provider: { require_parameters: true },
  });
  const message = responseMessage(rawResponse);
  if (typeof message?.content !== "string" || !message.content.trim()) {
    throw new Error("OpenRouter web search did not return textual evidence");
  }
  return {
    text: message.content,
    citations: parseUrlCitations(message.annotations),
    rawResponse,
  };
}

export async function extractImage(
  apiKey: string,
  model: string,
  dataUrl: string,
  context?: string,
): Promise<{ extraction: ImageExtraction; rawResponse: unknown }> {
  const { parsed, rawResponse } = await requestStructuredJson(
    apiKey,
    model,
    [
      {
        type: "text",
        text: [
          "Extract the durable information from this image saved from an X post.",
          "Transcribe visible text verbatim and preserve line breaks. Do not translate it.",
          "Also explain information communicated by diagrams, labels, layout, UI state, or other visual structure when it carries meaning.",
          "Key facts must be information-bearing and useful for understanding or reusing the source: code behavior, data, labels, claims, instructions, or meaningful relationships.",
          "Omit decorative details and generic presentation chrome from keyFacts, including colors, backgrounds, patterns, syntax highlighting, window controls, and ordinary editor or terminal framing unless they communicate something important.",
          "Use an empty verbatimText when there is no readable text. Record uncertainty instead of guessing.",
          ...(context ? [context] : []),
        ].join(" "),
      },
      { type: "image_url", image_url: { url: dataUrl } },
    ],
    "image_extraction",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: ["screenshot", "diagram", "photo", "document", "other"],
        },
        language: { type: ["string", "null"] },
        verbatimText: { type: "string" },
        visualSummary: { type: "string" },
        keyFacts: { type: "array", items: { type: "string" } },
        uncertainties: { type: "array", items: { type: "string" } },
      },
      required: [
        "kind",
        "language",
        "verbatimText",
        "visualSummary",
        "keyFacts",
        "uncertainties",
      ],
    },
  );

  const value = object(parsed);
  const kind = value?.kind;
  const language = value?.language;
  const verbatimText = value?.verbatimText;
  const visualSummary = value?.visualSummary;
  const keyFacts = strings(value?.keyFacts);
  const uncertainties = strings(value?.uncertainties);
  if (
    !["screenshot", "diagram", "photo", "document", "other"].includes(
      typeof kind === "string" ? kind : "",
    ) ||
    !(typeof language === "string" || language === null) ||
    typeof verbatimText !== "string" ||
    typeof visualSummary !== "string" ||
    !keyFacts ||
    !uncertainties
  ) {
    throw new Error("OpenRouter image extraction failed runtime validation");
  }

  return {
    extraction: {
      kind: kind as ImageExtraction["kind"],
      language,
      verbatimText,
      visualSummary,
      keyFacts,
      uncertainties,
      model,
    },
    rawResponse,
  };
}

export async function translateText(
  apiKey: string,
  model: string,
  sourceLanguage: string,
  text: string,
): Promise<{ translation: Translation; rawResponse: unknown }> {
  const { parsed, rawResponse } = await requestStructuredJson(
    apiKey,
    model,
    [
      {
        type: "text",
        text: `Translate the following ${sourceLanguage} text faithfully into natural English. Preserve technical names, paths, code, lists, and intent. Do not summarize.\n\n${text}`,
      },
    ],
    "translation",
    {
      type: "object",
      additionalProperties: false,
      properties: { translatedText: { type: "string" } },
      required: ["translatedText"],
    },
  );
  const translatedText = object(parsed)?.translatedText;
  if (typeof translatedText !== "string" || !translatedText.trim()) {
    throw new Error("OpenRouter translation failed runtime validation");
  }
  return {
    translation: {
      sourceLanguage,
      targetLanguage: "en",
      translatedText,
      model,
    },
    rawResponse,
  };
}
