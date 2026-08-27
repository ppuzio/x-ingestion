import assert from "node:assert/strict";
import test from "node:test";

import { requestStructuredJson } from "./openrouter.ts";

test("retries one malformed structured-model response", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: calls === 1 ? "not json" : '{"ok":true}' } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await requestStructuredJson(
      "test-key",
      "test/model",
      [{ type: "text", text: "test" }],
      "test_response",
      {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
    );
    assert.deepEqual(result.parsed, { ok: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
