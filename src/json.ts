export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function objects(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(object).filter((item): item is JsonObject => item !== undefined)
    : [];
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Strict: undefined unless every item is a string. Use for model output. */
export function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

/** Lenient: keeps the string items and discards the rest. Use for X API payloads. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => string(item) ?? []) : [];
}
