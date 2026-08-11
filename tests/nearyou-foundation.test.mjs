import assert from "node:assert/strict";
import test from "node:test";
import {
  FEATURE_FLAGS,
  PLAN_CATALOG,
  PRODUCT_COMPATIBILITY,
  canonicalJobRequestHash,
  featureFlagsFromEnv,
  householdIdForUser,
  jobTypeEnabled,
  nearSleepNarratorPolicy,
  resolveEffectiveEntitlement,
  resolveLegacyEntitlement,
  roleCan,
  nearSleepProductionEnabled,
  weightedUsage,
} from "../lib/nearyou-foundation.ts";

test("NearYou metadata keeps every live NearSleep URL compatible", () => {
  assert.equal(PRODUCT_COMPATIBILITY.umbrella, "NearYou");
  assert.equal(PRODUCT_COMPATIBILITY.currentProduct, "Nearnight");
  assert.equal(PRODUCT_COMPATIBILITY.productFamily, "NearSleep");
  assert.deepEqual(PRODUCT_COMPATIBILITY.preservedApiPaths, [
    "/api/account",
    "/api/audio/[id]",
    "/api/auth/[...all]",
    "/api/billing/checkout",
    "/api/billing/portal",
    "/api/pronunciation",
    "/api/scripts",
    "/api/sessions",
    "/api/voices",
    "/api/webhooks/stripe",
  ]);
});

test("runtime household IDs match the deterministic migration bridge", () => {
  assert.equal(householdIdForUser("user_1"), "household:user_1");
  assert.throws(() => householdIdForUser(""), /user id/i);
});

test("safety-gated capabilities stay disabled even when environment input requests them", () => {
  const flags = featureFlagsFromEnv({
    NEARYOU_ENABLE_CHILD_MICROPHONE: "true",
    NEARYOU_ENABLE_POSTHUMOUS_SYNTHESIS: "true",
    NEARYOU_ENABLE_STORY: "true",
  });

  assert.equal(flags.childMicrophone, false);
  assert.equal(flags.posthumousSynthesis, false);
  assert.equal(flags.story, true);
  assert.equal(featureFlagsFromEnv({}).foundationApi, false);
  assert.equal(featureFlagsFromEnv({}).productionUpgradeFoundation, false);
  assert.equal(featureFlagsFromEnv({ NEARYOU_ENABLE_PRODUCTION_UPGRADE_FOUNDATION: "true" }).productionUpgradeFoundation, true);
  assert.equal(featureFlagsFromEnv({}).nearSleepProduction, false);
  assert.equal(featureFlagsFromEnv({ NEARYOU_ENABLE_NEARSLEEP_PRODUCTION: "true" }).nearSleepProduction, true);
  assert.equal(featureFlagsFromEnv({}).requireVerifiedVoiceConsent, false);
  assert.equal(featureFlagsFromEnv({ NEARYOU_REQUIRE_VERIFIED_VOICE_CONSENT: "true" }).requireVerifiedVoiceConsent, true);
  assert.equal(featureFlagsFromEnv({ NEARYOU_ENABLE_FOUNDATION_API: "true" }).foundationApi, true);
  assert.equal(FEATURE_FLAGS.stripeLiveMode, false);
});

test("the first paid NearYou tier includes NearSleep and parent-controlled NearStory", () => {
  const plus = PLAN_CATALOG.nearyou_plus;
  assert.equal(plus.monthlyPriceUsd, 14.99);
  assert.equal(plus.annualPriceUsd, 149.99);
  assert.equal(plus.features.nearsleep, true);
  assert.equal(plus.features.nearstoryParentControlled, true);
  assert.equal(plus.features.childMicrophone, false);
  assert.deepEqual(plus.limits, { children: 2, voices: 1, members: 2, narrationMinutes: 60, transcriptionMinutes: 0, storageBytes: 5_000_000_000 });
  assert.equal(PLAN_CATALOG.nearyou_family.monthlyPriceUsd, 24.99);
  assert.equal(PLAN_CATALOG.nearyou_family.annualPriceUsd, 249.99);
  assert.deepEqual(PLAN_CATALOG.nearyou_family.limits, { children: 5, voices: 2, members: 5, narrationMinutes: 120, transcriptionMinutes: 0, storageBytes: 25_000_000_000 });
  assert.equal(PLAN_CATALOG.nearlegacy.monthlyPriceUsd, 39.99);
  assert.equal(PLAN_CATALOG.nearlegacy.annualPriceUsd, 399.99);
  assert.deepEqual(PLAN_CATALOG.nearlegacy.limits, { children: 5, voices: 5, members: 8, narrationMinutes: 120, transcriptionMinutes: 180, storageBytes: 100_000_000_000 });
});

test("Free production uses a standard narrator while private voice cloning remains paid", () => {
  assert.deepEqual(nearSleepNarratorPolicy("nearsleep_free", false), {
    standardNarratorAvailable: true,
    privateVoiceCloneAllowed: false,
  });
  assert.deepEqual(nearSleepNarratorPolicy("nearyou_plus", false), {
    standardNarratorAvailable: false,
    privateVoiceCloneAllowed: true,
  });
  assert.deepEqual(nearSleepNarratorPolicy("nearyou_family", true), {
    standardNarratorAvailable: true,
    privateVoiceCloneAllowed: true,
  });
});

test("household roles enforce read, management, and ownership boundaries", () => {
  assert.equal(roleCan("listener", "household:read"), true);
  assert.equal(roleCan("listener", "playlist:write"), false);
  assert.equal(roleCan("adult_manager", "child:write"), true);
  assert.equal(roleCan("adult_manager", "invitation:write"), false);
  assert.equal(roleCan("owner", "invitation:write"), true);
});

test("jobs remain hard-disabled until an atomic entitlement reservation exists", () => {
  const workerOnly = featureFlagsFromEnv({ NEARYOU_ENABLE_FOUNDATION_API: "true", NEARYOU_ENABLE_ASYNC_MEDIA_JOBS: "true", NEARYOU_ENABLE_USAGE_RESERVATIONS: "true" });
  assert.equal(jobTypeEnabled("nearsleep_audio", workerOnly), false);
  assert.equal(jobTypeEnabled("story_audio", workerOnly), false);
  assert.equal(jobTypeEnabled("archive_transcription", workerOnly), false);
  assert.equal(jobTypeEnabled("media_export", workerOnly), false);
  assert.equal(jobTypeEnabled("story_audio", { ...workerOnly, story: true }), false);
});

test("NearSleep production requires every coordinated migration and enforcement gate", () => {
  const complete = {
    NEARYOU_ENABLE_FOUNDATION_API: "true",
    NEARYOU_ENABLE_PRODUCTION_UPGRADE_FOUNDATION: "true",
    NEARYOU_ENABLE_NEARSLEEP_PRODUCTION: "true",
    NEARYOU_ENABLE_USAGE_RESERVATIONS: "true",
    NEARYOU_REQUIRE_VERIFIED_VOICE_CONSENT: "true",
  };
  assert.equal(nearSleepProductionEnabled(featureFlagsFromEnv(complete)), true);
  for (const missing of Object.keys(complete)) {
    assert.equal(nearSleepProductionEnabled(featureFlagsFromEnv({ ...complete, [missing]: "false" })), false, `${missing} must remain mandatory`);
  }
});

test("effective entitlement comes from the selected household grant", () => {
  const now = new Date("2026-08-11T00:00:00.000Z");
  const entitlement = resolveEffectiveEntitlement([
    { planId: "nearyou_family", status: "grace", allowanceMilliunits: 120_000, remainingMilliunits: 90_000, validFrom: new Date("2026-08-01"), validUntil: new Date("2026-08-20"), updatedAt: new Date("2026-08-02") },
    { planId: "nearyou_plus", status: "active", allowanceMilliunits: 60_000, remainingMilliunits: 55_000, validFrom: new Date("2026-08-03"), validUntil: new Date("2026-08-20"), updatedAt: new Date("2026-08-04") },
  ], now);
  assert.equal(entitlement.planId, "nearyou_plus");
  assert.equal(entitlement.status, "active");
  assert.equal(entitlement.remainingMilliunits, 55_000);
  assert.deepEqual(entitlement.features, PLAN_CATALOG.nearyou_plus.features);
  const paidGraceOverFree = resolveEffectiveEntitlement([
    { planId: "nearsleep_free", status: "active", allowanceMilliunits: 1_000, remainingMilliunits: 1_000, validFrom: new Date("2026-01-01"), validUntil: null, updatedAt: new Date("2026-08-10") },
    { planId: "nearyou_family", status: "grace", allowanceMilliunits: 120_000, remainingMilliunits: 70_000, validFrom: new Date("2026-08-01"), validUntil: new Date("2026-08-18"), updatedAt: new Date("2026-08-09") },
  ], now);
  assert.equal(paidGraceOverFree.planId, "nearyou_family");
  assert.equal(paidGraceOverFree.status, "grace");
  assert.throws(() => resolveEffectiveEntitlement([]), /household entitlement/i);
  assert.throws(() => resolveEffectiveEntitlement([
    { planId: "nearyou_plus", status: "active", allowanceMilliunits: 60_000, remainingMilliunits: 55_000, validFrom: new Date("2026-08-01"), validUntil: new Date("2026-08-10"), updatedAt: new Date("2026-08-04") },
  ], now), /household entitlement/i);
  assert.throws(() => resolveEffectiveEntitlement([
    { planId: "nearyou_plus", status: "grace", allowanceMilliunits: 60_000, remainingMilliunits: 55_000, validFrom: new Date("2026-08-12"), validUntil: new Date("2026-08-20"), updatedAt: new Date("2026-08-04") },
  ], now), /household entitlement/i);
});

test("job request hashes are canonical across JSON key order", async () => {
  const first = await canonicalJobRequestHash("nearsleep_audio", { sessionId: "session_1", options: { b: 2, a: 1 } });
  const reordered = await canonicalJobRequestHash("nearsleep_audio", { options: { a: 1, b: 2 }, sessionId: "session_1" });
  const changed = await canonicalJobRequestHash("nearsleep_audio", { sessionId: "session_2", options: { a: 1, b: 2 } });
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("active current subscribers retain the grandfathered Plus entitlement and credits", () => {
  const entitlement = resolveLegacyEntitlement({
    subscriptionStatus: "active",
    creditsRemaining: 7,
  });

  assert.equal(entitlement.planId, "nearsleep_plus_legacy");
  assert.equal(entitlement.remainingMilliunits, 7_000);
  assert.equal(PLAN_CATALOG.nearsleep_plus_legacy.monthlyAllowanceMilliunits, 12_000);
  assert.equal(PLAN_CATALOG.nearsleep_plus_legacy.monthlyPriceUsd, 12);
});

test("weighted usage uses integer milliunits and rejects invalid quantities", () => {
  assert.equal(weightedUsage("nearsleep_audio_generation", 12), 12_000);
  assert.equal(weightedUsage("nearsleep_audio_preview", 2), 200);
  assert.equal(weightedUsage("playback", 50), 0);
  assert.throws(() => weightedUsage("nearsleep_audio_generation", -1), /non-negative integer/i);
});
