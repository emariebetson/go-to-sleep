import assert from "node:assert/strict";
import test from "node:test";
import { shouldApplyPronunciationGuess } from "../lib/studio-pronunciation.ts";

test("a guess applies only to the unchanged nickname and edit version", () => {
  assert.equal(shouldApplyPronunciationGuess("Lachy", "Lachy", 0, 0), true);
  assert.equal(shouldApplyPronunciationGuess("Lachy", "Lou", 0, 0), false);
  assert.equal(shouldApplyPronunciationGuess("Lachy", "Lachy", 0, 1), false);
  assert.equal(shouldApplyPronunciationGuess("  Lachy ", "Lachy", 2, 2), true);
});
