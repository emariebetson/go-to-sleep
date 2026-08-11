import assert from "node:assert/strict";
import test from "node:test";
import { assessChildNarrationSafety, moderatedNarrationOrFallback, synthesizeAfterChildModeration } from "../lib/child-safety.ts";

test("child narration classifier covers sexual content, violence and abuse, self-harm, and unsafe care", () => {
  assert.deepEqual(assessChildNarrationSafety("The moon glows softly and your grown-up is nearby."), { safe: true, category: null });
  for (const [category, narration] of [
    ["sexual", "The stranger describes sexual touching."],
    ["violence", "Take the weapon and kill the little animal."],
    ["abuse", "Shake the baby until the crying stops."],
    ["self_harm", "You should hurt yourself tonight."],
    ["unsafe_care", "Leave the baby alone in the bath and walk away."],
    ["unsafe_care", "Place the baby face down for bedtime."],
    ["unsafe_care", "Cover the baby's head with a blanket."],
    ["unsafe_care", "Use a weighted blanket in the crib."],
    ["unsafe_care", "Put a pillow in the infant's crib."],
    ["unsafe_care", "Give the baby alcohol before bedtime."],
    ["unsafe_care", "Leave the child unsupervised by the pool."],
    ["violence", "Burn and drown the little animal."],
  ]) {
    assert.deepEqual(assessChildNarrationSafety(narration), { safe: false, category });
  }
});

test("edited narration never reaches synthesis when moderation flags or is uncertain", async () => {
  for (const verdict of ["unsafe", "unavailable"]) {
    let synthesized = false;
    await assert.rejects(() => synthesizeAfterChildModeration(
      "A superficially gentle edited narration.",
      async () => verdict,
      async () => { synthesized = true; return "audio"; },
    ), /edited_narration/);
    assert.equal(synthesized, false);
  }
  let locallySynthesized = false;
  await assert.rejects(() => synthesizeAfterChildModeration(
    "Give the baby poison.",
    async () => "safe",
    async () => { locallySynthesized = true; return "audio"; },
  ), /edited_narration/);
  assert.equal(locallySynthesized, false);
  assert.equal(await synthesizeAfterChildModeration("A quiet moon drifts by.", async () => "safe", async () => "audio"), "audio");
});

test("classifier normalizes simple evasive spelling and punctuation", () => {
  assert.equal(assessChildNarrationSafety("k!ll and h.u.r.t the baby").safe, false);
  assert.equal(assessChildNarrationSafety("s3xual t0uching").safe, false);
  assert.equal(assessChildNarrationSafety("self h a r m").safe, false);
});

test("moderation uses a deterministic safe fallback on flagged or uncertain output", async () => {
  const fallback = "A small lantern glows while the room becomes quiet.";
  const flagged = await moderatedNarrationOrFallback("A calm-looking but remotely flagged output.", fallback, async () => "unsafe");
  assert.deepEqual(flagged, { script: fallback, fallbackUsed: true, reason: "remote_unsafe" });
  const unavailable = await moderatedNarrationOrFallback("A calm-looking output.", fallback, async () => "unavailable");
  assert.deepEqual(unavailable, { script: fallback, fallbackUsed: true, reason: "moderation_unavailable" });
  const local = await moderatedNarrationOrFallback("Shake the baby.", fallback, async () => "safe");
  assert.deepEqual(local, { script: fallback, fallbackUsed: true, reason: "local_abuse" });
  const safe = await moderatedNarrationOrFallback("A quiet cloud floats beneath the moon.", fallback, async () => "safe");
  assert.deepEqual(safe, { script: "A quiet cloud floats beneath the moon.", fallbackUsed: false, reason: null });
});
