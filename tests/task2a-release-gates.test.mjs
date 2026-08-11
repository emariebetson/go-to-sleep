import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Task 2A routes stay dark before authentication, database, or provider work", () => {
  for (const path of ["app/api/onboarding/route.ts", "app/api/voices/verification/route.ts"]) {
    const route = source(path);
    const gate = route.indexOf("productionUpgradeFoundation");
    assert.ok(gate >= 0, `${path} missing production-upgrade gate`);
    assert.ok(gate < route.indexOf("requireApiUser(request)"), `${path} authenticates before its default-off gate`);
  }
});

test("verification failure paths release the verification lock and fail the claimed challenge", () => {
  const route = source("app/api/voices/verification/route.ts");
  assert.match(route, /status: "processing", attempts:/);
  assert.match(route, /status: "failed", errorCode: "phrase_mismatch"/);
  assert.match(route, /status: "failed", errorCode: sql`COALESCE\([^`]*verification_failed[^`]*\)`/);
  assert.match(route, /claimedAttempts = 3/);
  assert.doesNotMatch(route, /return jsonNoStore\(\{ error: "Live voice verification is temporarily at capacity/);
  assert.doesNotMatch(route, /return jsonNoStore\(\{ error: "Verified voice creation is temporarily at capacity/);
});

test("replacement activation precedes best-effort retirement of the old provider voice", () => {
  const route = source("app/api/voices/verification/route.ts");
  const activated = route.indexOf("replacementActivated = true");
  const retired = route.indexOf("let retired = false");
  assert.ok(activated >= 0 && retired > activated);
  assert.match(route, /voices\.provider_voice_id.*originalProviderVoiceId/);
  assert.match(route, /voices\.current_consent_id.*originalConsentId/);
});

test("verification commits provider spend before calls that can charge and never releases it afterward", () => {
  const route = source("app/api/voices/verification/route.ts");
  for (const [spendId, providerCall] of [
    ["transcriptionSpendId", "transcribeLivePassage"],
    ["cloneSpendId", "createReplacementVoice"],
  ]) {
    const committed = route.indexOf(`markProviderSpendChargeCommitted(${spendId})`);
    const cleared = route.indexOf(`${spendId} = ""`, committed);
    const invoked = route.indexOf(providerCall, cleared);
    assert.ok(committed >= 0 && cleared > committed && invoked > cleared, `${providerCall} must run only after a durable charge commitment`);
  }
});

test("unreadable clone responses retain provider correlation evidence for reconciliation", () => {
  const route = source("app/api/voices/verification/route.ts");
  assert.match(route, /createReplacementVoice\([^)]*replacementId/);
  assert.match(route, /Correlation:/);
  assert.match(route, /COALESCE\([^)]*errorCode[^)]*verification_failed/);
});

test("onboarding exposes validation messages only and hides persistence failures", () => {
  const route = source("app/api/onboarding/route.ts");
  assert.match(route, /console\.error\("Adult caregiver onboarding failed"/);
  assert.match(route, /Adult caregiver onboarding could not be recorded\./);
  const outerCatch = route.slice(route.lastIndexOf("} catch (error)"));
  assert.doesNotMatch(outerCatch, /error instanceof Error \? error\.message/);
});
