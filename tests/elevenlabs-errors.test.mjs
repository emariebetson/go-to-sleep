import assert from "node:assert/strict";
import test from "node:test";
import { classifySpeechGenerationError, classifyVoiceCreationError } from "../lib/elevenlabs.ts";

test("maps the ElevenLabs cloning-plan rejection without exposing provider wording", () => {
  const rawMessage = "Your subscription does not include instant voice cloning. Please upgrade your plan.";
  const result = classifyVoiceCreationError(403, { detail: { message: rawMessage } });

  assert.equal(result.code, "voice_cloning_unavailable");
  assert.equal(result.httpStatus, 503);
  assert.doesNotMatch(result.message, /demo narrator/i);
  assert.doesNotMatch(result.message, /upgrade your plan/i);
  assert.notEqual(result.message, rawMessage);
});

test("does not offer the demo fallback for unrelated provider failures", () => {
  const result = classifyVoiceCreationError(401, { detail: { message: "Invalid API key" } });

  assert.equal(result.code, "voice_provider_unavailable");
  assert.doesNotMatch(result.message, /demo narrator/i);
});

test("gives invalid samples specific retry guidance", () => {
  const result = classifyVoiceCreationError(422, { detail: "Audio could not be decoded" });

  assert.equal(result.code, "voice_sample_invalid");
  assert.equal(result.httpStatus, 422);
  assert.match(result.message, /60–120 seconds/i);
});

test("maps depleted speech credits to an actionable provider message", () => {
  const result = classifySpeechGenerationError(401, JSON.stringify({ detail: { code: "quota_exceeded", message: "This request exceeds your quota." } }));

  assert.equal(result.code, "provider_quota_exhausted");
  assert.equal(result.httpStatus, 503);
  assert.match(result.message, /add provider credits|upgrade/i);
});
