import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { latestSnapshots } from "./snapshots.ts";

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
