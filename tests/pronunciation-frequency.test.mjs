import assert from "node:assert/strict";
import test from "node:test";
import { applyPronunciation, cleanNickname, cleanPronunciation, normalizeNickname } from "../lib/pronunciation.ts";
import { frequencyGainPerOscillator, parseStoredFrequencyLayers, validateFrequencyLayers } from "../lib/frequency-layers.ts";

test("pronunciation substitution changes standalone nickname occurrences only", () => {
  assert.equal(
    applyPronunciation("Lachy rests. LACHY's blanket is here. Lachyland stays visible.", "Lachy", "LOCK-ee"),
    "LOCK-ee rests. LOCK-ee's blanket is here. Lachyland stays visible.",
  );
  assert.equal(applyPronunciation("A.J. rests beside A.J.!", "A.J.", "AY-jay"), "AY-jay rests beside AY-jay!");
});

test("empty inputs leave narration unchanged", () => {
  assert.equal(applyPronunciation("Hello Lachy.", "Lachy", ""), "Hello Lachy.");
  assert.equal(applyPronunciation("Hello Lachy.", "", "LOCK-ee"), "Hello Lachy.");
});

test("pronunciation cleanup and nickname normalization are bounded", () => {
  assert.equal(cleanNickname("  LaCHy <name>  "), "LaCHy name");
  assert.equal(cleanPronunciation("  LOCK-ee <script>  "), "LOCK-ee script");
  assert.equal(normalizeNickname("  LaCHy  "), "lachy");
  assert.equal(cleanNickname("x".repeat(40)).length, 32);
  assert.equal(cleanPronunciation("x".repeat(80)).length, 64);
});

test("frequency validation accepts only three distinct supported layers", () => {
  assert.deepEqual(validateFrequencyLayers([174, 528, 963]), [174, 528, 963]);
  assert.throws(() => validateFrequencyLayers([174, 174]), /duplicate/i);
  assert.throws(() => validateFrequencyLayers([174, 285, 396, 417]), /three/i);
  assert.throws(() => validateFrequencyLayers([440]), /unsupported/i);
  assert.throws(() => validateFrequencyLayers("174"), /array/i);
});

test("stored layers fail closed and per-oscillator gain bounds the sum", () => {
  assert.deepEqual(parseStoredFrequencyLayers("[174,528]"), [174, 528]);
  assert.deepEqual(parseStoredFrequencyLayers("not json"), []);
  assert.equal(frequencyGainPerOscillator(0), 0);
  assert.equal(frequencyGainPerOscillator(1), 0.018);
  assert.ok(frequencyGainPerOscillator(3) * 3 <= 0.018);
});
