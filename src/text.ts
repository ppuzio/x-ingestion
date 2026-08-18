export function collapseWhitespace(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

export function stripUrls(value: string): string {
  return value.replace(/https?:\/\/\S+/g, "");
}
