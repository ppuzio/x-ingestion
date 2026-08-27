import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { readJson, writeJson } from "./json.ts";

test("atomically replaces JSON and identifies a malformed file", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "x-ingestion-json-"));
  const path = resolve(directory, "cache.json");
  try {
    await writeJson(path, { version: 1 });
    await writeJson(path, { version: 2 });
    assert.deepEqual(await readJson(path), { version: 2 });
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
      [],
    );

    const malformedPath = resolve(directory, "malformed.json");
    await writeFile(malformedPath, "{", "utf8");
    await assert.rejects(readJson(malformedPath), new RegExp(`Invalid JSON in ${malformedPath}`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
