import assert from "node:assert/strict";
import test from "node:test";
import { prepareNarration, validateNarrationDuration } from "../lib/session-narration.ts";

test("preview and full narration apply pronunciation without changing the stored script", () => {
  const script = "Hello Lachy. Lachy can rest beside the moon while the familiar voice continues softly for bedtime.";
  const result = prepareNarration({ script, childName: "Lachy", pronunciation: "LOCK-ee" });
  assert.equal(result.full, "Hello LOCK-ee. LOCK-ee can rest beside the moon while the familiar voice continues softly for bedtime.");
  assert.match(result.preview, /LOCK-ee/);
  assert.equal(script, "Hello Lachy. Lachy can rest beside the moon while the familiar voice continues softly for bedtime.");
});

test("empty pronunciation keeps preview and full narration unchanged", () => {
  const script = "Hello Lachy. The room grows softer and quieter while the gentle bedtime story continues nearby.";
  const result = prepareNarration({ script, childName: "Lachy", pronunciation: "" });
  assert.equal(result.full, script);
  assert.equal(result.preview, script);
});

test("prepared narration is bounded by selected duration before allowance or provider spend", () => {
  assert.equal(validateNarrationDuration("gentle ".repeat(550), 5), 550);
  assert.throws(() => validateNarrationDuration("gentle ".repeat(601), 5), /too long for a 5-minute session/i);
  assert.equal(validateNarrationDuration("gentle ".repeat(1200), 10), 1200);
  assert.throws(() => validateNarrationDuration("gentle ".repeat(1201), 10), /too long for a 10-minute session/i);
});
