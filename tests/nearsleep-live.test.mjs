import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalGenerationFingerprint,
  generationResultStorageKey,
  validateStoredGenerationResult,
} from "../lib/nearsleep-live.ts";

test("generation fingerprints are key-order stable and cover provider, consent, and billing-affecting input", async () => {
  const base = {
    requestId: "11111111-1111-4111-8111-111111111111",
    duration: 10,
    voiceId: "voice_1",
    script: "A calm script",
    frequencies: ["528", "432"],
    source: { title: "Quiet", url: "https://www.youtube.com/watch?v=abcdefghijk" },
  };
  const reordered = {
    source: { url: "https://www.youtube.com/watch?v=abcdefghijk", title: "Quiet" },
    frequencies: ["528", "432"],
    script: "A calm script",
    voiceId: "voice_1",
    duration: 10,
    requestId: "11111111-1111-4111-8111-111111111111",
  };
  assert.equal(await canonicalGenerationFingerprint(base), await canonicalGenerationFingerprint(reordered));
  for (const changed of [
    { ...base, duration: 20 },
    { ...base, voiceId: "voice_2" },
    { ...base, script: "A changed script" },
    { ...base, frequencies: ["528"] },
    { ...base, source: { ...base.source, title: "Changed" } },
  ]) {
    assert.notEqual(await canonicalGenerationFingerprint(base), await canonicalGenerationFingerprint(changed));
  }
});

test("recoverable result keys are tenant scoped and request deterministic", () => {
  const first = generationResultStorageKey("household:one", "script", "11111111-1111-4111-8111-111111111111");
  assert.equal(first, generationResultStorageKey("household:one", "script", "11111111-1111-4111-8111-111111111111"));
  assert.notEqual(first, generationResultStorageKey("household:two", "script", "11111111-1111-4111-8111-111111111111"));
  assert.match(first, /^generation-results\//);
});

test("stored recoverable results reject secrets, provider references, and malformed tenant metadata", () => {
  const metadata = { householdId: "household_1", userId: "adult_1", operationId: "operation_1" };
  assert.deepEqual(validateStoredGenerationResult(JSON.stringify({ script: "Quiet words", mode: "personalized" }), metadata, metadata), { script: "Quiet words", mode: "personalized" });
  assert.throws(() => validateStoredGenerationResult(JSON.stringify({ providerVoiceId: "provider_secret" }), metadata, metadata), /unsafe_generation_result/);
  assert.throws(() => validateStoredGenerationResult(JSON.stringify({ audioUrl: "/api/audio/1" }), { ...metadata, householdId: "other" }, metadata), /generation_result_tenant_mismatch/);
  assert.throws(() => validateStoredGenerationResult("[]", metadata, metadata), /invalid_generation_result/);
});
