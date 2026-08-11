import assert from "node:assert/strict";
import test from "node:test";
import { createNearStoryWorker, StoryPersistenceUncertainError, validateStoryWriterOutput } from "../lib/nearstory-worker.ts";

function fixture(overrides = {}) {
  const calls = { writer: 0, moderation: 0, tts: 0, effect: 0, mix: 0, complete: 0, fail: [], released: [] };
  let claimed = false;
  const work = { jobId: "job", storyId: "story", householdId: "house", voiceId: "voice", soundscape: "construction", durationMinutes: 10, maxDurationSeconds: 630 };
  return { calls, work, deps: {
    claimJob: async () => { if (claimed) return null; claimed = true; return work; },
    recoverPersisted: async () => null,
    requireConsent: async () => true,
    claimHold: async (_work, operation) => ({ id: `hold:${operation}`, operation, maxMicrocents: 100_000 }),
    settleHold: async () => undefined,
    releaseUnused: async (_work, reason) => { calls.released.push(reason); },
    writeStory: async () => { calls.writer += 1; return { segments: Array.from({ length: 5 }, (_, ordinal) => ({ ordinal, narration: `Lou and a kind dinosaur shared the bulldozer in part ${ordinal}.` })), model: "writer", requestId: "write-1" }; },
    moderateOutput: async () => { calls.moderation += 1; return { verdict: "safe", model: "moderator", requestId: "mod-1" }; },
    synthesize: async (_narration, _work, _hold, ordinal) => { calls.tts += 1; return { bytes: new Uint8Array([ordinal, 2, 3]), model: "voice-model", requestId: `tts-${ordinal}` }; },
    getCachedEffect: async () => null,
    effect: async () => { calls.effect += 1; return { bytes: new Uint8Array([4]), cached: false, requestId: "sfx-1" }; },
    mix: async ({ segments }) => { calls.mix += 1; return { audio: segments[0], segmentDurationsMs: [1000, 1000, 1000, 1000, 1000] }; },
    persist: async () => ({ mediaAssetId: "media", audioUrl: "/api/v1/stories/story/audio" }),
    complete: async () => { calls.complete += 1; },
    fail: async (_work, code) => { calls.fail.push(code); },
    ...overrides,
  } };
}

test("unsafe generated narration never reaches TTS and releases unused budget and allowance", async () => {
  const setup = fixture({ moderateOutput: async () => ({ verdict: "unsafe", model: "moderator", requestId: "mod-unsafe" }) });
  const result = await createNearStoryWorker(setup.deps).run("job");
  assert.deepEqual(result, { status: "failed", code: "story_output_unsafe" });
  assert.equal(setup.calls.tts, 0);
  assert.deepEqual(setup.calls.released, ["story_output_unsafe"]);
});

test("writer output is exactly five ordered bounded segments", () => {
  const valid = { segments: Array.from({ length: 5 }, (_, ordinal) => ({ ordinal, narration: `safe segment ${ordinal}` })), model: "writer", requestId: "request" };
  assert.equal(validateStoryWriterOutput(valid, 5).segments.length, 5);
  assert.throws(() => validateStoryWriterOutput({ ...valid, segments: valid.segments.slice(0, 4) }, 5), /five/i);
  assert.throws(() => validateStoryWriterOutput({ ...valid, segments: valid.segments.map((segment, index) => index === 2 ? { ...segment, ordinal: 4 } : segment) }, 5), /ordinal/i);
  assert.throws(() => validateStoryWriterOutput({ ...valid, segments: valid.segments.map((segment, index) => index === 0 ? { ...segment, narration: "word ".repeat(700) } : segment) }, 5), /word|character/i);
  assert.throws(() => validateStoryWriterOutput({ ...valid, segments: valid.segments.map((segment, index) => index === 0 ? { ...segment, toolCall: "browser" } : segment) }, 5), /field/i);
});

test("writer output enforces Unicode character ceilings independently of word count", () => {
  const giantToken = "🦕".repeat(1_201);
  assert.throws(() => validateStoryWriterOutput({ model: "writer-v1", requestId: "request-1", segments: Array.from({ length: 5 }, (_, ordinal) => ({ ordinal, narration: ordinal === 0 ? giantToken : "calm" })) }, 5), /character limit/);
});

test("revoked consent between writer and moderation stops every later provider call", async () => {
  let checks = 0;
  const setup = fixture({ requireConsent: async () => { checks += 1; if (checks > 1) throw new Error("consent_revoked"); return true; } });
  const result = await createNearStoryWorker(setup.deps).run("job");
  assert.deepEqual(result, { status: "failed", code: "story_consent_invalidated" });
  assert.equal(setup.calls.writer, 1);
  assert.equal(setup.calls.moderation, 0);
  assert.equal(setup.calls.tts, 0);
});

test("lost R2 persistence response recovers without repeating writer or speech providers", async () => {
  let durable = null;
  const setup = fixture({
    claimJob: async () => setup.work,
    recoverPersisted: async () => durable,
    persist: async () => { durable = { mediaAssetId: "media", audioUrl: "/api/v1/stories/story/audio" }; throw new StoryPersistenceUncertainError(); },
  });
  const worker = createNearStoryWorker(setup.deps);
  assert.deepEqual(await worker.run("job"), { status: "retryable", code: "story_persistence_uncertain" });
  assert.equal(setup.calls.writer, 1); assert.equal(setup.calls.tts, 5);
  assert.deepEqual(await worker.run("job"), { status: "completed", result: durable, recovered: true });
  assert.equal(setup.calls.writer, 1); assert.equal(setup.calls.tts, 5); assert.equal(setup.calls.complete, 1);
});

test("successful worker uses one bounded writer call and five aligned segment TTS calls", async () => {
  const setup = fixture();
  const result = await createNearStoryWorker(setup.deps).run("job");
  assert.equal(result.status, "completed");
  assert.deepEqual({ writer: setup.calls.writer, moderation: setup.calls.moderation, tts: setup.calls.tts, effect: setup.calls.effect, mix: setup.calls.mix, complete: setup.calls.complete }, { writer: 1, moderation: 1, tts: 5, effect: 1, mix: 1, complete: 1 });
});
