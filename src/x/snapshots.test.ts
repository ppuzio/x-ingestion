import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { latestNormalizedSnapshot, latestSnapshots } from "./snapshots.ts";

test("selects the latest snapshot independently for likes and bookmarks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "x-ingestion-snapshots-"));
  try {
    await writeFile(join(directory, "likes-2026-01-02T00-00-00-page-001.json"), "{}", "utf8");
    await writeFile(join(directory, "bookmarks-2026-01-01T00-00-00-page-001.json"), "{}", "utf8");
    await writeFile(join(directory, "likes-2026-01-03T00-00-00-page-001.json"), "{}", "utf8");
    await writeFile(join(directory, "bookmarks-2026-01-02T00-00-00-page-001.json"), "{}", "utf8");

    const paths = await latestSnapshots(directory);
    assert.deepEqual(
      paths.map((path) => path.split("/").at(-1)),
      [
        "likes-2026-01-03T00-00-00-page-001.json",
        "bookmarks-2026-01-02T00-00-00-page-001.json",
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("selects the newest full normalized snapshot, never a per-post preview", async () => {
  const directory = await mkdtemp(join(tmpdir(), "x-ingestion-normalized-"));
  try {
    await writeFile(join(directory, "x-2026-01-01T00-00-00.normalized.json"), "[]", "utf8");
    await writeFile(join(directory, "x-2026-01-02T00-00-00-123.normalized.json"), "[]", "utf8");
    await writeFile(join(directory, "x-2026-01-03T00-00-00.normalized.json"), "[]", "utf8");

    assert.equal(
      (await latestNormalizedSnapshot(directory))?.split("/").at(-1),
      "x-2026-01-03T00-00-00.normalized.json",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
