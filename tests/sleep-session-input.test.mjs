import assert from "node:assert/strict";
import test from "node:test";
import { validateSessionInput } from "../lib/sleep-session.ts";

const valid = {
  requestId: "12345678-1234-4123-8123-123456789abc",
  childName: "Lachy",
  pronunciation: "LOCK-ee",
  ageMonths: 6,
  challenge: "settling",
  theme: "moonlit-meadow",
  duration: "10",
  sound: "soft-rain",
  frequencies: [174, 528],
  style: "slow-story",
  scriptMode: "personalized",
  contentType: "story",
  sourceUrl: "",
  sourceTitle: "",
  script: "Hello, sweet Lachy. The room grows quiet while the moonlight rests softly nearby for a peaceful bedtime story.",
  voiceId: "voice_12345678",
  narrationKind: "parent_clone",
  generationMode: "preview",
};

test("session input carries a cleaned pronunciation and validated layers", () => {
  const result = validateSessionInput(valid);
  assert.equal(result.pronunciation, "LOCK-ee");
  assert.deepEqual(result.frequencies, [174, 528]);
});

test("session input defaults missing optional narration settings", () => {
  const result = validateSessionInput({ ...valid, pronunciation: undefined, frequencies: undefined });
  assert.equal(result.pronunciation, "");
  assert.deepEqual(result.frequencies, []);
});

test("session input rejects a fourth, duplicate, or unsupported layer", () => {
  assert.throws(() => validateSessionInput({ ...valid, frequencies: [174, 285, 396, 417] }), /three/i);
  assert.throws(() => validateSessionInput({ ...valid, frequencies: [174, 174] }), /duplicate/i);
  assert.throws(() => validateSessionInput({ ...valid, frequencies: [440] }), /unsupported/i);
});
