import assert from "node:assert/strict";
import test from "node:test";
import { createNearFamilyPrivateDecisionClient } from "../lib/nearfamily-private-decision-client.ts";
import { nearFamilySourceActivated } from "../lib/nearfamily-activation.ts";
import { runNearFamilyPrivateRouteRollback } from "../lib/nearfamily-route.ts";
import { readFileSync } from "node:fs";

const releaseId = "rel_20260820_private_01";
const key = "a".repeat(64);
const now = 1_787_000_000_000;

function decisionClient(response, overrides = {}) {
  return createNearFamilyPrivateDecisionClient({
    endpoint: "https://readiness.invalid/v1/nearfamily/decision",
    signingKey: key,
    keyVersion: 1,
    releaseId,
    now: () => now,
    nonce: () => "nonce_abcdefghijklmnopqrstuv",
    fetch: async () => response,
    ...overrides,
  });
}

test("private decision client sends only a canonical signed household hash and admits an exact unexpired response", async () => {
  let request;
  const client = decisionClient(new Response(JSON.stringify({ version: 1, allowed: true, expiresAt: now + 60_000 }), { status: 200, headers: { "content-type": "application/json" } }), {
    fetch: async (input, init) => {
      request = { input, init };
      return new Response(JSON.stringify({ version: 1, allowed: true, expiresAt: now + 60_000 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(await client.authorize("hh_abcdefghijklmnop"), true);
  const body = JSON.parse(request.init.body);
  assert.deepEqual(Object.keys(body), ["bodySha256", "householdHash", "issuedAt", "keyVersion", "nonce", "releaseId", "signature", "version"]);
  assert.match(body.householdHash, /^[a-f0-9]{64}$/);
  assert.ok(!request.init.body.includes("hh_abcdefghijklmnop"));
  assert.equal(request.init.headers["content-length"], undefined);
});

test("private decision client fails closed on denied, malformed, expired, or failed gateway responses", async () => {
  for (const response of [
    new Response(JSON.stringify({ version: 1, allowed: false }), { status: 200, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ version: 1, allowed: true, expiresAt: now }), { status: 200, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ version: 1, allowed: true, expiresAt: now + 60_000, extra: true }), { status: 200, headers: { "content-type": "application/json" } }),
    new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } }),
  ]) assert.equal(await decisionClient(response).authorize("hh_abcdefghijklmnop"), false);
  assert.equal(await decisionClient(null, { fetch: async () => { throw new Error("network"); } }).authorize("hh_abcdefghijklmnop"), false);
});

test("private decision client fails closed for invalid gate configuration", async () => {
  assert.equal(await decisionClient(null, { endpoint: "http://insecure.invalid" }).authorize("hh_abcdefghijklmnop"), false);
  assert.equal(await decisionClient(null, { signingKey: "not-a-key" }).authorize("hh_abcdefghijklmnop"), false);
  assert.equal(await decisionClient(null, { releaseId: "rel_wrong" }).authorize("hh_abcdefghijklmnop"), false);
});

test("NearFamily defaults dark and can enable only the explicit private route", () => {
  assert.equal(nearFamilySourceActivated(), false);
  assert.equal(nearFamilySourceActivated("false"), false);
  assert.equal(nearFamilySourceActivated("private"), true);
  const route = readFileSync(new URL("../app/api/v1/family/route.ts", import.meta.url), "utf8");
  assert.match(route, /createNearFamilyPrivateDecisionClient/);
  assert.match(route, /NEARFAMILY_PRIVATE_ROUTE_ENABLED/);
  assert.match(route, /NEARFAMILY_DECISION_SIGNING_KEY/);
  assert.doesNotMatch(route, /createPostgresPrivateTesterInvitationEvaluator/);
});

test("NearFamily rollback kills and proves denial before restoring the prior Worker", async () => {
  const operations = [];
  await runNearFamilyPrivateRouteRollback({
    emergencyKillAndRevoke: async () => { operations.push("kill"); },
    confirmDenied: async () => { operations.push("denied"); },
    fencePendingWork: async () => { operations.push("fence"); },
    revokeTestEntitlement: async () => { operations.push("entitlement"); },
    restorePriorWorker: async () => { operations.push("restore"); },
    verifyRecovery: async () => { operations.push("recovery"); },
  });
  assert.deepEqual(operations, ["kill", "denied", "fence", "entitlement", "restore", "recovery"]);

  const blocked = [];
  await assert.rejects(() => runNearFamilyPrivateRouteRollback({
    emergencyKillAndRevoke: async () => { blocked.push("kill"); },
    confirmDenied: async () => { throw new Error("still allowed"); },
    fencePendingWork: async () => { blocked.push("fence"); },
    revokeTestEntitlement: async () => { blocked.push("entitlement"); },
    restorePriorWorker: async () => { blocked.push("restore"); },
    verifyRecovery: async () => { blocked.push("recovery"); },
  }), /still allowed/);
  assert.deepEqual(blocked, ["kill"]);
});
