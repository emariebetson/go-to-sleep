import assert from "node:assert/strict";
import test from "node:test";
import { localPronunciationGuess, requestPronunciationGuess } from "../lib/pronunciation-guess.ts";

test("local pronunciation exceptions handle known ambiguous nicknames without provider spend", () => {
  assert.equal(localPronunciationGuess("Lachy"), "LOCK-ee");
  assert.equal(localPronunciationGuess("  LACHY  "), "LOCK-ee");
  assert.equal(localPronunciationGuess("UnlistedName"), "");
});

test("pronunciation guessing returns one cleaned readable respelling", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ output_text: "LOCK-ee\n" }), { status: 200 });
  assert.equal(await requestPronunciationGuess("Lachy", "test-key", fakeFetch), "LOCK-ee");
});

test("pronunciation guessing supports the structured Responses payload", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "AY-jay" }] }] }), { status: 200 });
  assert.equal(await requestPronunciationGuess("A.J.", "test-key", fakeFetch), "AY-jay");
});

test("pronunciation guessing rejects empty, explanatory, or markup provider output", async () => {
  for (const outputText of ["", "LOCK-ee\nThis is my explanation", "<script>"]) {
    const fakeFetch = async () => new Response(JSON.stringify({ output_text: outputText }), { status: 200 });
    await assert.rejects(() => requestPronunciationGuess("Lachy", "test-key", fakeFetch), /valid pronunciation/i);
  }
});

test("pronunciation guessing hides provider response details", async () => {
  const fakeFetch = async () => new Response("secret provider diagnostic", { status: 429 });
  await assert.rejects(
    () => requestPronunciationGuess("Lachy", "test-key", fakeFetch),
    (error) => error instanceof Error && !error.message.includes("secret provider diagnostic"),
  );
});
