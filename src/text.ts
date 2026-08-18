export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function stripUrls(value: string): string {
  return value.replace(/https?:\/\/\S+/g, "");
}
