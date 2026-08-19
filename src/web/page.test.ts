import assert from "node:assert/strict";
import test from "node:test";

import {
  extractReadablePage,
  hasUnsafeAddressSet,
  isPrivateAddress,
  webPageFragment,
} from "./page.ts";

test("blocks private network addresses", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.1.2.3"), true);
  assert.equal(isPrivateAddress("192.168.1.2"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
  assert.equal(hasUnsafeAddressSet(["fe80::1", "138.197.69.146"]), false);
  assert.equal(hasUnsafeAddressSet(["127.0.0.1", "8.8.8.8"]), true);
  assert.equal(hasUnsafeAddressSet(["fe80::1"]), true);
});

test("extracts and validates readable article text", () => {
  const page = extractReadablePage(
    Buffer.from(`<!doctype html><html><head><title>Fallback title</title></head><body>
      <article><h1>Useful article</h1><p>First substantive paragraph about a useful technique.</p>
      <p>Second substantive paragraph with enough context for a knowledge note.</p></article>
    </body></html>`),
    "https://example.com/article",
  );
  assert.equal(page.title, "Fallback title");
  assert.match(page.text, /First substantive paragraph/);

  const fragment = webPageFragment({
    sourceUrl: "https://example.com/article",
    finalUrl: "https://example.com/article",
    contentType: "text/html",
    title: page.title,
    text: page.text,
    capturedAt: "2026-08-19T00:00:00Z",
    rawPath: "data/raw/web/1/page.html",
  });
  assert.equal(fragment.kind, "web_page");
  assert.equal(fragment.title, "Fallback title");
});

test("uses an embedded page title when static metadata is absent", () => {
  const page = extractReadablePage(
    Buffer.from(`<html><body><script>var blog_title = "Transformers from Scratch";</script>
      <main><p>A sufficiently useful article body for deterministic extraction.</p></main>
    </body></html>`),
    "https://example.com/article",
  );
  assert.equal(page.title, "Transformers from Scratch");
});
