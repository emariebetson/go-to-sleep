import assert from "node:assert/strict";
import test from "node:test";
import { prepareNarration } from "../lib/session-narration.ts";

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
