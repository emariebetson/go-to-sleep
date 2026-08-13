import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertPlatformActivation,
  canonicalRowsChecksum,
  decryptOfflineAsset,
  encryptOfflineAsset,
  evaluateMobileEntitlementEvent,
  integrationPolicy,
  parseRevenueCatEntitlementEvent,
  redactTelemetry,
  verifyRevenueCatAuthorization,
} from "../lib/platform-release.ts";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("platform activation fails closed until every infrastructure gate is present", () => {
  const verified = { releaseId: "release_1", schemaChecksum: "a".repeat(64), backfillChecksum: "b".repeat(64), backfill: "verified", shadowReads: "verified", rlsNegativeTest: "verified", mediaWorker: "verified" };
  assert.throws(() => assertPlatformActivation({}, verified), /PostgreSQL cutover is not enabled/);
  assert.throws(() => assertPlatformActivation({ NEARYOU_ENABLE_POSTGRES_CUTOVER: "true" }, verified), /DATABASE_URL/);
  assert.deepEqual(assertPlatformActivation({
    NEARYOU_ENABLE_POSTGRES_CUTOVER: "true",
    DATABASE_URL: "postgresql://configured/db?sslmode=require",
    NEARYOU_RELEASE_ID: "release_1",
    NEARYOU_POSTGRES_SCHEMA_CHECKSUM: "a".repeat(64),
  }, verified), { database: "postgres", mediaWorker: "ready" });
  assert.throws(() => assertPlatformActivation({ NEARYOU_ENABLE_POSTGRES_CUTOVER: "true", DATABASE_URL: "postgresql://configured/db?sslmode=require", NEARYOU_RELEASE_ID: "release_1", NEARYOU_POSTGRES_SCHEMA_CHECKSUM: "a".repeat(64) }, { ...verified, rlsNegativeTest: "pending" }), /durable release evidence/);
  assert.throws(() => assertPlatformActivation({ NEARYOU_ENABLE_POSTGRES_CUTOVER: "true", DATABASE_URL: "postgresql://configured/db?sslmode=require", NEARYOU_RELEASE_ID: "other", NEARYOU_POSTGRES_SCHEMA_CHECKSUM: "a".repeat(64) }, verified), /does not match/);
});

test("backfill checksums are stable across row and property order", async () => {
  const left = await canonicalRowsChecksum([{ id: "b", value: 2 }, { value: 1, id: "a" }]);
  const right = await canonicalRowsChecksum([{ id: "a", value: 1 }, { id: "b", value: 2 }]);
  assert.equal(left, right);
  assert.notEqual(left, await canonicalRowsChecksum([{ id: "a", value: 9 }, { id: "b", value: 2 }]));
});

test("RevenueCat authorization validates timestamped raw-body signature and rejects stale events", async () => {
  const body = JSON.stringify({ event: { id: "rc_1", event_timestamp_ms: 1_786_400_000_000 } });
  const secret = "rc_private_test_secret";
  const now = 1_786_400_000_000;
  const timestamp = Math.floor(now / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  const signature = Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(await verifyRevenueCatAuthorization(body, `t=${timestamp},v1=${signature}`, secret, now), true);
  assert.equal(await verifyRevenueCatAuthorization(`${body}x`, `t=${timestamp},v1=${signature}`, secret, now), false);
  assert.equal(await verifyRevenueCatAuthorization(body, `t=${timestamp - 301},v1=${signature}`, secret, now), false);
  assert.deepEqual(evaluateMobileEntitlementEvent({ id: "rc_1", occurredAtMs: 200, priorOccurredAtMs: 100, alreadyProcessed: false }), { action: "apply" });
  assert.deepEqual(evaluateMobileEntitlementEvent({ id: "rc_1", occurredAtMs: 100, priorOccurredAtMs: 200, alreadyProcessed: false }), { action: "ignore_stale" });
  assert.deepEqual(evaluateMobileEntitlementEvent({ id: "rc_1", occurredAtMs: 200, priorOccurredAtMs: 100, alreadyProcessed: true }), { action: "ignore_replay" });
  assert.deepEqual(parseRevenueCatEntitlementEvent({ event: { id: "rc_1", app_id: "app_nearyou", environment: "SANDBOX", product_id: "nearyou_plus_monthly", entitlement_ids: ["nearyou_plus"], app_user_id: "rcusr_0123456789abcdef0123456789abcdef", event_timestamp_ms: 200, type: "INITIAL_PURCHASE", expiration_at_ms: 999 } }, { appIds: ["app_nearyou"], productIds: ["nearyou_plus_monthly"], entitlementIds: ["nearyou_plus"], environment: "SANDBOX" }), { id: "rc_1", appId: "app_nearyou", appUserId: "rcusr_0123456789abcdef0123456789abcdef", occurredAtMs: 200, productId: "nearyou_plus_monthly", entitlementId: "nearyou_plus", environment: "SANDBOX",eventType:"INITIAL_PURCHASE",expiresAtMs:999 });
  assert.throws(() => parseRevenueCatEntitlementEvent({ event: { id: "rc_2", app_id: "evil", environment: "SANDBOX", product_id: "nearyou_plus_monthly", entitlement_ids: ["nearyou_plus"], app_user_id: "user@example.com", event_timestamp_ms: 200, type: "INITIAL_PURCHASE", expiration_at_ms: 999 } }, { appIds: ["app_nearyou"], productIds: ["nearyou_plus_monthly"], entitlementIds: ["nearyou_plus"], environment: "SANDBOX" }), /allowlist/);
});

test("offline downloads encrypt audio and never persist bearer credentials", async () => {
  const plaintext = new TextEncoder().encode("private family audio");
  const key = crypto.getRandomValues(new Uint8Array(32));
  const encrypted = await encryptOfflineAsset(plaintext, key, { mediaId: "media_1", accessToken: "must-not-persist" });
  assert.equal(new TextDecoder().decode(encrypted.ciphertext).includes("private family audio"), false);
  assert.equal(JSON.stringify(encrypted).includes("must-not-persist"), false);
  assert.deepEqual(await decryptOfflineAsset(encrypted, key), plaintext);
  const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.slice() };
  tampered.ciphertext[0] ^= 1;
  await assert.rejects(() => decryptOfflineAsset(tampered, key));
  await assert.rejects(() => decryptOfflineAsset(encrypted, crypto.getRandomValues(new Uint8Array(32))));
});

test("media integrations enforce catalog-only Spotify and rights-safe YouTube behavior", () => {
  assert.deepEqual(integrationPolicy("spotify", "create_catalog_playlist"), { allowed: true, requiresOAuth: true, requiresRightsAttestation: false });
  assert.deepEqual(integrationPolicy("spotify", "upload_private_audio"), { allowed: false, reason: "private_audio_upload_prohibited" });
  assert.deepEqual(integrationPolicy("youtube", "import_metadata"), { allowed: true, requiresOAuth: false, requiresRightsAttestation: false });
  assert.deepEqual(integrationPolicy("youtube", "adapt_content"), { allowed: true, requiresOAuth: false, requiresRightsAttestation: true });
  assert.deepEqual(integrationPolicy("youtube", "rip_audio"), { allowed: false, reason: "media_ripping_prohibited" });
});

test("privacy-safe telemetry recursively removes PII and secrets", () => {
  const redacted = redactTelemetry({ email: "parent@example.com", token: "secret", childName: "Lou", nested: { authorization: "Bearer no", jobId: "job_1" } });
  assert.deepEqual(redacted, { email: "[REDACTED]", token: "[REDACTED]", childName: "[REDACTED]", nested: { authorization: "[REDACTED]", jobId: "job_1" } });
  const circular = { requestId: "req_1" }; circular.self = circular;
  assert.deepEqual(redactTelemetry(circular), { requestId: "req_1", self: "[REDACTED]" });
});

test("PostgreSQL RLS and operational artifacts encode the release invariants", () => {
  const migration = source("postgres/migrations/0001_nearyou_tenant_foundation.sql");
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(migration, /current_setting\('app\.household_id', true\)/);
  assert.match(migration, /current_setting\('app\.user_id', true\)/);
  assert.match(source("scripts/postgres-cutover.ts"), /backfill|shadow|delta|rollback/gi);
  assert.match(source("media-worker/worker.py"), /ffmpeg/);
  assert.match(source("mobile/app.json"), /near-you/);
  assert.match(source("mobile/src/auth.ts"), /apple/i);
  assert.match(source("docs/runbooks/production-release.md"), /restore drill/i);
  assert.match(source("docs/security/THREAT_MODEL.md"), /voice impersonation/i);
});
