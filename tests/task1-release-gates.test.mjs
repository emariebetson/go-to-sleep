import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("legacy generation can require current verified voice consent behind its rollout gate", () => {
  const route = source("app/api/sessions/route.ts");
  assert.match(route, /leftJoin\(voiceConsents, eq\(voices\.currentConsentId, voiceConsents\.id\)\)/);
  assert.match(route, /requireVerifiedVoiceConsent/);
  assert.match(route, /eq\(voiceConsents\.status, "active_verified"\)/);
});

test("self-attestation remains pending and legacy voice creation respects consent FK ordering", () => {
  const v1 = source("app/api/v1/voices/route.ts");
  assert.match(v1, /status: "pending_verification"/);
  assert.doesNotMatch(v1, /status: "active_verified"/);

  const legacy = source("app/api/voices/route.ts");
  const voiceInsert = legacy.indexOf("createLegacyVoice(env.DB");
  const consentInsert = legacy.indexOf("db.insert(voiceConsents)");
  const pointerUpdate = legacy.indexOf("currentConsentId: consentId");
  assert.ok(voiceInsert >= 0 && voiceInsert < consentInsert && consentInsert < pointerUpdate);
});

test("invitation acceptance claims pending invitation before creating membership", () => {
  const route = source("app/api/v1/household/invitations/accept/route.ts");
  assert.ok(route.indexOf("db.update(householdInvitations)") < route.indexOf("db.insert(householdMembers)"));
  assert.match(route, /existingMember.*status === "active"/s);
  assert.doesNotMatch(route, /onConflictDoUpdate/);
});
