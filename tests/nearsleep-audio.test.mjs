import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProductionAudioRequest,
  productionSessionId,
  sessionAudioStorageKey,
  previewAudioStorageKey,
  validateAudioGenerationResult,
} from "../lib/nearsleep-audio.ts";

const requestId = "11111111-1111-4111-8111-111111111111";
const base = {
  requestId,
  childId: "child-profile:local_1",
  childName: "Junie",
  pronunciation: "JOO-nee",
  ageMonths: 8,
  challenge: "settling",
  theme: "moonlit-meadow",
  duration: "5",
  sound: "none",
  frequencies: [],
  style: "slow-story",
  scriptMode: "curated",
  contentType: "story",
  sourceUrl: "",
  sourceTitle: "Moon",
  script: "Junie watches a gentle moon drift above the quiet meadow while a familiar grown-up stays nearby. The soft grass sways, the little stars glow, and every slow breath makes the room feel peaceful and safe.",
  voiceId: "voice_local_1",
  narrationKind: "parent_clone",
  generationMode: "save",
};

test("production audio parsing fingerprints stable local child, voice, billing, and narration inputs", async () => {
  const parsed = await parseProductionAudioRequest(base);
  assert.equal(parsed.input.providerVoiceId, "voice_local_1");
  assert.equal(parsed.childProfileId, "child-profile:local_1");
  assert.equal(parsed.wordCount, parsed.narration.trim().split(/\s+/).length);
  assert.equal(parsed.fingerprint, (await parseProductionAudioRequest({ ...base })).fingerprint);
  for (const changed of [
    { ...base, childId: "child-profile:local_2" },
    { ...base, voiceId: "voice_local_2" },
    { ...base, duration: "10" },
    { ...base, script: `${base.script} Another gentle sentence.` },
  ]) assert.notEqual(parsed.fingerprint, (await parseProductionAudioRequest(changed)).fingerprint);
});

test("a Free-compatible five-minute request rejects oversized prepared narration before provider work", async () => {
  await assert.rejects(() => parseProductionAudioRequest({ ...base, script: "gentle ".repeat(701) }), /too long for a 5-minute session/i);
});

test("bedtime speech slows the narrator enough for duration-calibrated scripts", async () => {
  const audio = await import("../lib/nearsleep-audio.ts");
  assert.equal(audio.bedtimeVoiceSettings?.().speed, 0.8);
});

test("preview spend measurement uses only the prepared excerpt while duration validation uses the full script", async () => {
  const script = Array.from({ length: 100 }, (_, index) => `gentle${index}`).join(" ");
  const parsed = await parseProductionAudioRequest({ ...base, generationMode: "preview", script });
  assert.equal(parsed.wordCount, 68);
  assert.equal(parsed.narration.trim().split(/\s+/).length, 68);
});

test("production parsing preserves the approved child age band above 24 months", async () => {
  const parsed = await parseProductionAudioRequest({ ...base, ageMonths: 60 });
  assert.equal(parsed.input.ageMonths, 60);
  await assert.rejects(() => parseProductionAudioRequest({ ...base, ageMonths: 97 }), /age/i);
});

test("production audio rejects unsafe edited narration and provider-shaped IDs", async () => {
  await assert.rejects(() => parseProductionAudioRequest({ ...base, script: `${base.script} Shake the baby until the crying stops.` }), /safety boundaries/i);
  await assert.rejects(() => parseProductionAudioRequest({ ...base, childId: "provider/secret" }), /child profile/i);
});

test("production session and audio keys are deterministic and tenant scoped", async () => {
  const one = await productionSessionId("household_1", requestId);
  const two = await productionSessionId("household_2", requestId);
  assert.equal(one, await productionSessionId("household_1", requestId));
  assert.notEqual(one, two);
  assert.equal(sessionAudioStorageKey("household_1", one), `audio/household_1/${one}.mp3`);
  assert.equal(previewAudioStorageKey("household_1", requestId), `audio-previews/household_1/${requestId}.mp3`);
});

test("audio generation results are bounded and never expose provider references", () => {
  assert.deepEqual(validateAudioGenerationResult({ sessionId: "session_1", audioUrl: "/api/audio/session_1", generationMode: "save" }), {
    sessionId: "session_1",
    audioUrl: "/api/audio/session_1",
    generationMode: "save",
  });
  assert.throws(() => validateAudioGenerationResult({ sessionId: "session_1", audioUrl: "https://provider.example/audio", generationMode: "save" }), /invalid_generation_result/);
  assert.throws(() => validateAudioGenerationResult({ sessionId: "session_1", audioUrl: "/api/audio/session_1", generationMode: "save", providerRequestId: "secret" }), /invalid_generation_result/);
});
