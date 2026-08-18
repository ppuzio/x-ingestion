import type { ImageExtraction, Translation } from "../model.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

export async function requestStructuredJson(
  apiKey: string,
  model: string,
  content: unknown[],
  schemaName: string,
  schema: JsonObject,
): Promise<{ parsed: unknown; rawResponse: unknown }> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 4_000,
      messages: [{ role: "user", content }],
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema },
      },
      provider: { require_parameters: true },
    }),
  });
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenRouter request failed (${response.status} ${response.statusText}): ${rawText}`,
    );
  }

  let rawResponse: unknown;
  try {
    rawResponse = JSON.parse(rawText);
  } catch {
    throw new Error("OpenRouter returned invalid JSON");
  }
  const choices = object(rawResponse)?.choices;
  const message = Array.isArray(choices) ? object(object(choices[0])?.message) : undefined;
  const messageContent = message?.content;
  if (typeof messageContent !== "string") {
    throw new Error("OpenRouter response did not contain textual JSON output");
  }

  try {
    return { parsed: JSON.parse(messageContent), rawResponse };
  } catch {
    throw new Error("OpenRouter model output was not valid JSON");
  }
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
          "Also explain information communicated by layout, diagrams, UI state, or other visual structure.",
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
