import assert from "node:assert/strict";
import test from "node:test";

import { renderLibraryBase } from "./base.ts";

test("renders scoped native Base views for captures and human-owned reviews", () => {
  const base = renderLibraryBase();

  assert.match(base, /file\.inFolder\("Sources"\)/);
  assert.match(base, /file\.inFolder\("Reviews"\)/);
  assert.match(base, /type == "x-capture"/);
  assert.match(base, /type == "x-review"/);

  for (const view of [
    "Captures",
    "Topics",
    "Source gaps",
    "Relevance",
    "Reviews",
    "Unread reviews",
    "Review status",
  ]) {
    assert.match(base, new RegExp(`name: ${view}`));
  }

  for (const property of [
    "note.title",
    "note.post_id",
    "note.topics",
    "note.author",
    "note.captured",
    "note.relevance_status",
    "note.source_gaps",
    "note.review",
    "note.source",
    "note.status",
  ]) {
    assert.match(base, new RegExp(property.replace(".", "\\.")));
  }

  assert.match(base, /file\.hasProperty\("topics"\)/);
  assert.match(base, /file\.hasProperty\("source_gaps"\)/);
  assert.match(base, /file\.hasProperty\("relevance_status"\)/);
  assert.match(base, /- 'status == "unread"'/);
  assert.doesNotMatch(base, /\t/);
  assert.ok(base.endsWith("\n"));
});
