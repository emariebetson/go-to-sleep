import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("saved-audio production remains dark before legacy auth or behavior", () => {
  const route = source("app/api/sessions/route.ts");
  const post = route.indexOf("export async function POST");
  const productionGate = route.indexOf("nearSleepProduction", post);
  const legacyAuth = route.indexOf("requireApiUser(request)", post);
  assert.ok(productionGate > post && productionGate < legacyAuth);
  assert.match(route.slice(post, legacyAuth), /return postProductionSession\(request\)/);
});

test("saved-audio wiring claims before entitlement, allowance, and provider work", () => {
  const route = source("app/api/sessions/production.ts");
  const handler = route.indexOf("createDurableGenerationPostHandler");
  const claim = route.indexOf("claimGenerationOperation", handler);
  const entitlement = route.indexOf("requireCurrentNearSleepEntitlement", claim);
  const allowance = route.indexOf("reserveHouseholdAllowance", entitlement);
  const provider = route.indexOf("generateSpeech(apiKey", allowance);
  assert.ok(handler >= 0 && claim > handler && entitlement > claim && allowance > entitlement && provider > allowance);
  assert.match(route, /providerSpendEstimateMicrocents\("elevenlabs", "audio", parsed\.wordCount\)/);
  assert.match(route, /voiceId: input\.providerVoiceId/);
  assert.doesNotMatch(route, /eq\(voices\.providerVoiceId, input\./);
  assert.match(route, /loadSelectableChildProfile\(householdId, parsed\.childProfileId\)/);
  assert.match(source("lib/nearsleep-selectors.ts"), /isNull\(childProfiles\.archivedAt\)/);
  assert.match(route, /childProfile\.nickname !== input\.childName[\s\S]*childProfile\.pronunciation/);
});

test("provider output is tenant-stored before lease consumption and atomic ready finalization", () => {
  const route = source("app/api/sessions/production.ts");
  const execute = route.indexOf("execute: async");
  const audioPut = route.indexOf("await bucket()!.put(state.audioKey", execute);
  const leaseConsume = route.indexOf('finalizeVoiceConsentLease({ householdId, userId }, state.leaseId, "consumed")', audioPut);
  const ready = route.indexOf("await finalizeSavedSession({", leaseConsume);
  const durableResult = route.indexOf("await storeResult", ready);
  assert.ok(audioPut > execute && leaseConsume > audioPut && ready > leaseConsume && durableResult > ready);
  assert.match(route, /customMetadata:\s*\{[\s\S]*householdId,[\s\S]*userId,[\s\S]*operationId,[\s\S]*requestId/);
  assert.match(route, /deleteOrReconcile\(state\.sessionId \|\| "preview"/);
  assert.ok(route.split("finalizeSavedSession({").length >= 4, "normal and recovery paths share media/session finalization");
  assert.match(route, /await cleanupFailedExecution\(\{ householdId, userId \}, state\);/);
  assert.doesNotMatch(route, /if \(!\(error instanceof GenerationResultReconciliationError\)\).*cleanupFailedExecution/);
  assert.match(route, /mediaAssetId: session\.mediaAssetId \|\| `media:\$\{sessionId\}`/);
});

test("preview playback is default-off, tenant-authenticated, and revalidates consumed consent", () => {
  const route = source("app/api/audio-preview/[id]/route.ts");
  const gate = route.indexOf("nearSleepProductionEnabled");
  const auth = route.indexOf("requireHouseholdContext(request");
  assert.ok(gate >= 0 && gate < auth);
  assert.match(route, /customMetadata\?\.householdId !== householdId/);
  assert.match(route, /validateConsumedVoiceConsentLease/);
  assert.match(route, /cache-control": "private, no-store"/);
});

test("Stripe webhook claims are fenced and unfinished duplicates remain retryable", () => {
  const route = source("app/api/webhooks/stripe/production.ts");
  assert.match(route, /attemptToken/);
  assert.match(route, /eq\(stripeEvents\.attemptToken, attemptToken\)/);
  assert.match(route, /claim\.kind === "processing"[\s\S]*status: 503/);
  assert.doesNotMatch(route, /claim\.kind === "processing"[\s\S]{0,120}status: 202/);
});

test("checkout replays one durable Stripe session and binds only that session", () => {
  const checkout = source("app/api/billing/checkout/production.ts");
  const webhook = source("app/api/webhooks/stripe/production.ts");
  assert.match(checkout, /checkoutOperationId/);
  assert.match(checkout, /checkoutSessionId/);
  assert.match(checkout, /idempotencyKey: `checkout-\$\{householdId\}-\$\{operationId\}`/);
  assert.doesNotMatch(checkout, /Math\.floor\(now\.getTime\(\) \/ \(15 \* 60 \* 1000\)\)/);
  assert.match(webhook, /checkoutSessionId, checkout\.sessionId/);
  assert.match(webhook, /checkout\.session\.expired/);
  assert.match(checkout, /readLimitedBytes\(request, 2_048\)/);
  assert.doesNotMatch(checkout, /await request\.text\(\)/);
});

test("invoice handlers defer to newer subscription ordering", () => {
  const webhook = source("app/api/webhooks/stripe/production.ts");
  assert.match(webhook, /stripeInvoiceOrderingDecision/);
  assert.equal(webhook.split("await invoiceStatusAllows(event, binding").length - 1, 2);
  assert.match(webhook, /stripe_invoice_waiting_for_subscription_state/);
  assert.match(webhook, /stripeGet\(`\/subscriptions\//);
  assert.match(webhook, /remainingMilliunits: 0,[\s\S]{0,220}externalRef: update\.subscriptionId/);
  assert.match(webhook, /historical\.supersededAt\) return/);
});

test("Free narration is standard-provider only and clone verification rechecks the current household plan", () => {
  const voices = source("app/api/voices/production.ts");
  const verification = source("app/api/voices/verification/route.ts");
  const sessions = source("app/api/sessions/production.ts");
  assert.match(voices, /nearSleepNarratorPolicy/);
  assert.match(voices, /voiceCloneAllowed/);
  assert.match(verification, /loadVoiceCloneEligibility/);
  assert.ok(verification.split("loadVoiceCloneEligibility").length >= 3, "challenge issue and claimed upload both recheck eligibility");
  assert.match(sessions, /standardNarratorAvailable/);
  assert.match(source("app/pricing/page.tsx"), /standard non-cloned narrator/i);
});

test("Free duration and remaining allowance are checked before script provider work and reflected in Studio", () => {
  const scripts = source("app/api/scripts/production.ts");
  const voices = source("app/api/voices/production.ts");
  const studio = source("app/studio/SleepStudio.tsx");
  const account = source("app/account/page.tsx");
  const entitlement = scripts.indexOf("requireCurrentNearSleepEntitlement");
  const savePolicy = scripts.indexOf("narrationSavePolicy", entitlement);
  const youtube = scripts.indexOf("resolveYouTubeSource", savePolicy);
  const openai = scripts.indexOf("personalizedScriptResult(input, true)", savePolicy);
  assert.ok(entitlement >= 0 && savePolicy > entitlement && youtube > savePolicy && openai > savePolicy);
  assert.match(voices, /allowedNarrationDurations/);
  assert.match(studio, /allowedNarrationDurations/);
  assert.match(studio, /allowedDurations\.map/);
  assert.match(account, /one five-minute creation remaining/);
  assert.match(account, /five-minute creation used/);
});
