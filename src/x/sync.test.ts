import assert from "node:assert/strict";
import test from "node:test";

import type { SavedPost } from "../model.ts";
import {
  captureFingerprint,
  reconcileSyncState,
  SYNC_STATE_VERSION,
  type SyncState,
} from "./sync.ts";

function post(
  id: string,
  text: string,
  captureMethods: SavedPost["captureMethods"] = ["like"],
): SavedPost {
  return {
    id,
    url: `https://x.com/i/web/status/${id}`,
    capturedAt: "2026-01-02T00:00:00Z",
    author: { id: "author" },
    fragments: [{ kind: "text", source: "post", text }],
    relationships: [],
    captureMethods,
    rawSources: captureMethods.map((method) => ({
      method,
      snapshot: `data/raw/${method}.json`,
      post: { id, text },
    })),
  };
}

test("reconciles new, changed, unchanged, and overlapping captures", () => {
  const first = post("1", "same", ["like", "bookmark"]);
  const previous: SyncState = {
    version: SYNC_STATE_VERSION,
    updatedAt: "2026-01-01T00:00:00Z",
    posts: {
      "1": {
        sourceHash: captureFingerprint(post("1", "same", ["like"])),
        captureMethods: ["like"],
        firstSeenAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-01T00:00:00Z",
      },
      "2": {
        sourceHash: captureFingerprint(post("2", "old")),
        captureMethods: ["like"],
        firstSeenAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-01T00:00:00Z",
      },
    },
  };

  const result = reconcileSyncState(
    previous,
    [first, post("2", "new"), post("3", "new")],
    "2026-01-02T00:00:00Z",
  );
  assert.deepEqual(result.summary, {
    total: 3,
    newIds: ["3"],
    changedIds: ["2"],
    unchangedIds: ["1"],
  });
  assert.deepEqual(result.state.posts["1"]?.captureMethods, ["bookmark", "like"]);
  assert.equal(result.state.posts["1"]?.firstSeenAt, "2026-01-01T00:00:00Z");
  assert.equal(result.state.posts["1"]?.lastSeenAt, "2026-01-02T00:00:00Z");
  assert.ok(result.state.posts["2"]);
  assert.ok(result.state.posts["3"]);
});
