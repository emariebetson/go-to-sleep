import assert from "node:assert/strict";
import test from "node:test";
import { assertSameOrigin, assertTrustedMutationOrigin, readJsonObject, readLimitedBytes } from "../lib/http.ts";

function streamingRequest(chunks) {
  return new Request("https://example.test/upload", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    duplex: "half",
  });
}

test("byte-limited uploads reject oversized chunked bodies without Content-Length", async () => {
  const request = streamingRequest(["12345", "67890"]);
  await assert.rejects(() => readLimitedBytes(request, 8), (error) => error instanceof Response && error.status === 413);
});

test("byte-limited uploads preserve an in-bounds body", async () => {
  const bytes = await readLimitedBytes(streamingRequest(["voice", "-sample"]), 20);
  assert.equal(new TextDecoder().decode(bytes), "voice-sample");
});

test("JSON limits cancel chunked bodies as soon as the cap is crossed", async () => {
  let pulls = 0;
  const request = new Request("https://example.test/json", {
    method: "POST",
    body: new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode('{"long":1'));
        else throw new Error("the parser read beyond the byte limit");
      },
    }),
    duplex: "half",
  });
  await assert.rejects(() => readJsonObject(request, 8), (error) => error instanceof Response && error.status === 413);
  assert.equal(pulls, 1);
});

test("production mutation provenance is same-origin and fails closed when missing", () => {
  assert.doesNotThrow(() => assertTrustedMutationOrigin(new Request("https://example.test/action", { headers: { origin: "https://example.test", "sec-fetch-site": "same-origin" } })));
  assert.throws(() => assertTrustedMutationOrigin(new Request("https://example.test/action")), (error) => error instanceof Response && error.status === 403);
  assert.throws(() => assertTrustedMutationOrigin(new Request("https://example.test/action", { headers: { origin: "https://attacker.test", "sec-fetch-site": "cross-site" } })), (error) => error instanceof Response && error.status === 403);
  assert.doesNotThrow(() => assertSameOrigin(new Request("https://example.test/legacy")));
});
