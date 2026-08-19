import assert from "node:assert/strict";
import test from "node:test";

import type { SavedPost } from "../model.ts";
import { synthesisFingerprint } from "./enrich-post.ts";

function post(text: string): SavedPost {
  return {
    id: "1",
    url: "https://x.com/i/web/status/1",
    capturedAt: "2026-01-02T00:00:00Z",
    author: { id: "author" },
    fragments: [{ kind: "text", source: "post", text }],
    relationships: [],
    captureMethods: ["like"],
    rawSources: [],
  };
}

test("changes the synthesis fingerprint when source content changes", () => {
  assert.equal(synthesisFingerprint(post("same")), synthesisFingerprint(post("same")));
  assert.notEqual(synthesisFingerprint(post("same")), synthesisFingerprint(post("changed")));
});
