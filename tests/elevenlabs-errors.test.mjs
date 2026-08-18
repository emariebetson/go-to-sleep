import assert from "node:assert/strict";
import test from "node:test";
import * as elevenLabsErrors from "../lib/elevenlabs.ts";

const { classifySpeechGenerationError, classifyVoiceCreationError } = elevenLabsErrors;

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

test("maps the provider's subscription_required response to unavailable voice cloning", async () => {
  const response = Response.json({
    detail: {
      status: "subscription_required",
      message: "A paid subscription is required to access this feature.",
    },
  }, { status: 403 });

  const result = await elevenLabsErrors.parseVoiceCreationResponse(response);

  assert.equal(result.ok, false);
  assert.equal(result.responseReadable, true);
  assert.equal(result.failure.code, "voice_cloning_unavailable");
  assert.equal(result.failure.httpStatus, 503);
  assert.match(result.failure.message, /provider plan/i);
});

test("maps depleted voice-provider credits to an actionable message", () => {
  const result = classifyVoiceCreationError(401, {
    detail: {
      status: "quota_exceeded",
      message: "This request exceeds your quota.",
    },
  });

  assert.equal(result.code, "provider_quota_exhausted");
  assert.equal(result.httpStatus, 503);
  assert.match(result.message, /provider credits/i);
});

test("turns a non-JSON provider response into a stable failure", async () => {
  assert.equal(typeof elevenLabsErrors.parseVoiceCreationResponse, "function");
  const response = new Response("upstream unavailable", { status: 502 });

  const result = await elevenLabsErrors.parseVoiceCreationResponse(response);

  assert.deepEqual(result, {
    ok: false,
    responseReadable: false,
    failure: {
      code: "voice_provider_unavailable",
      message: "Voice setup is temporarily unavailable. Please try again later.",
      httpStatus: 502,
    },
  });
});

test("accepts a bounded successful provider voice response", async () => {
  const response = Response.json({ voice_id: "voice_123" }, { status: 200 });

  const result = await elevenLabsErrors.parseVoiceCreationResponse(response);

  assert.deepEqual(result, { ok: true, voiceId: "voice_123", responseReadable: true });
});

test("cancels a provider response whose declared body is oversized", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("{}")); },
    cancel() { cancelled = true; },
  }), { status: 502, headers: { "content-length": "64001" } });

  const result = await elevenLabsErrors.parseVoiceCreationResponse(response);

  assert.equal(result.ok, false);
  assert.equal(result.responseReadable, false);
  assert.equal(cancelled, true);
});

test("turns a thrown provider request into a privacy-safe stable failure", () => {
  assert.equal(typeof elevenLabsErrors.classifyVoiceRequestException, "function");

  const result = elevenLabsErrors.classifyVoiceRequestException(new TypeError("secret upstream detail"));

  assert.deepEqual(result, {
    causeClass: "TypeError",
    failure: {
      code: "voice_provider_unavailable",
      message: "Voice setup is temporarily unavailable. Please try again later.",
      httpStatus: 502,
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /secret upstream detail/);
});
