import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CloudKmsPublicKeyClient, PostgresNonceMaintenance, PostgresNonceStore } from "../lib/release-evidence-adapters.ts";

const crc32c = (text) => {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0x82f63b78 & -(crc & 1));
  }
  return String((crc ^ 0xffffffff) >>> 0);
};

const migration = readFileSync(new URL("../postgres/migrations/0002_release_evidence_trust.sql", import.meta.url), "utf8");
test("Postgres evidence roles expose only narrow security-definer functions", () => {
  assert.match(migration, /CREATE ROLE nearyou_release_policy_owner NOLOGIN NOINHERIT BYPASSRLS/);
  assert.match(migration, /ALTER FUNCTION nearyou\.consume_evidence_nonce[\s\S]*OWNER TO nearyou_release_policy_owner/);
  assert.match(migration, /REVOKE ALL ON FUNCTION nearyou\.consume_evidence_nonce[\s\S]*FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION nearyou\.consume_evidence_nonce[\s\S]*TO nearyou_release_verifier/);
  assert.match(migration, /FOR UPDATE SKIP LOCKED LIMIT p_limit/);
  assert.match(migration, /release_evidence_audit_immutable/);
  assert.doesNotMatch(migration, /GRANT (?:SELECT|INSERT|UPDATE|DELETE).*consumed_evidence_nonces TO nearyou_release_verifier/);
  assert.doesNotMatch(migration, /GRANT (?:SELECT,)?INSERT,UPDATE ON nearyou\.release_signing_keys TO nearyou_release_key_manager/);
  assert.match(migration, /CREATE FUNCTION nearyou\.register_release_signing_key/);
  assert.match(migration, /CREATE FUNCTION nearyou\.transition_release_signing_key/);
  assert.match(migration, /OLD\.fingerprint IS DISTINCT FROM NEW\.fingerprint/);
  assert.match(migration, /release_signing_key_audit_immutable/);
  assert.match(migration, /ALTER EXTENSION pgcrypto SET SCHEMA nearyou_crypto/);
  assert.match(migration, /nearyou_crypto\.digest\(p_nonce,'sha256'\)/);
  assert.match(migration, /GRANT USAGE ON SEQUENCE nearyou\.release_signing_key_audit_audit_id_seq TO nearyou_release_policy_owner/);
  assert.doesNotMatch(migration, /revoked_at BETWEEN valid_from AND valid_until/);
});

const nonceInput = { nonce: "abcdefghijklmnopqrstuv", claimsDigest: "a".repeat(64), principal: "ci://release", keyId: "key-1", keyVersion: 1, releaseId: "rel_1", expiresAt: Date.now() + 60_000 };
test("nonce store converges after a committed response is lost", async () => {
  let inserted = false; let lose = true;
  const db = { query: async () => { if (!inserted) { inserted = true; if (lose) { lose = false; throw new Error("lost response"); } return { rows: [{ consumed: true }] }; } return { rows: [{ consumed: false }] }; } };
  const store = new PostgresNonceStore(db);
  await assert.rejects(() => store.consume(nonceInput), /lost/);
  assert.equal(await store.consume(nonceInput), false);
});

test("concurrent nonce consumption admits exactly one and cleanup is bounded", async () => {
  let inserted = false;
  const db = { query: async (sql, args) => { if (sql.includes("consume_evidence_nonce")) { await new Promise((resolve) => setTimeout(resolve, 5)); if (inserted) return { rows: [{ consumed: false }] }; inserted = true; return { rows: [{ consumed: true }] }; } assert.deepEqual(args, [25]); return { rows: [{ removed: 25 }] }; } };
  const store = new PostgresNonceStore(db); const outcomes = await Promise.all([store.consume(nonceInput), store.consume(nonceInput)]); assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(await new PostgresNonceMaintenance(db).cleanup(25), 25); await assert.rejects(() => new PostgresNonceMaintenance(db).cleanup(1001), /limit/);
});

async function kmsFixture(overrides = {}) {
  const pair = await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encoded = Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64"); const lines = encoded.match(/.{1,64}/g).join("\n");
  const name = "projects/near-prod/locations/us-central1/keyRings/release/cryptoKeys/evidence/cryptoKeyVersions/2";
  const pem = `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
  const body = { name, pem, pemCrc32c: crc32c(pem), algorithm: "RSA_SIGN_PSS_3072_SHA256", protectionLevel: "HSM", ...overrides };
  return { name, body };
}
function client(publicKeyFetch, accessToken = async () => "token_abcdefghijklmnopqrstuvwxyz") {
  const fetch = async (url, init) => {
    if (url.endsWith("/cryptoKeys/evidence")) return response({ name: "projects/near-prod/locations/us-central1/keyRings/release/cryptoKeys/evidence", purpose: "ASYMMETRIC_SIGN" });
    if (url.endsWith("/cryptoKeyVersions/2")) return response({ name: "projects/near-prod/locations/us-central1/keyRings/release/cryptoKeys/evidence/cryptoKeyVersions/2", state: "ENABLED", protectionLevel: "HSM", algorithm: "RSA_SIGN_PSS_3072_SHA256" });
    return publicKeyFetch(url, init);
  };
  return new CloudKmsPublicKeyClient({ project: "near-prod", location: "us-central1", keyRing: "release", key: "evidence", principal: "ci://release", keyId: "evidence", accessToken, fetch });
}
const response = (body, headers = {}) => { const text = JSON.stringify(body); return new Response(text, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(text)), ...headers } }); };

test("KMS lookup imports an exact mapped enabled HSM RSA-PSS public key", async () => {
  const f = await kmsFixture(); let authorization;
  const record = await client(async (_url, init) => (authorization = init.headers.authorization, response(f.body))).lookup("ci://release", "evidence", 2);
  assert.equal(record.version, 2); assert.equal(record.key.usages[0], "verify"); assert.equal(authorization, "Bearer token_abcdefghijklmnopqrstuvwxyz"); assert.match(record.fingerprint, /^[a-f0-9]{64}$/);
});

test("KMS lookup verifies parent purpose and version state from their authoritative resources", async () => {
  const f = await kmsFixture();
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    if (url.endsWith("/cryptoKeys/evidence")) return response({ name: f.name.replace(/\/cryptoKeyVersions\/2$/, ""), purpose: "ASYMMETRIC_SIGN" });
    if (url.endsWith("/cryptoKeyVersions/2")) return response({ name: f.name, state: "ENABLED", protectionLevel: "HSM", algorithm: "RSA_SIGN_PSS_3072_SHA256" });
    return response({ name: f.name, pem: f.body.pem, pemCrc32c: f.body.pemCrc32c, algorithm: f.body.algorithm, protectionLevel: f.body.protectionLevel });
  };
  const direct = new CloudKmsPublicKeyClient({ project: "near-prod", location: "us-central1", keyRing: "release", key: "evidence", principal: "ci://release", keyId: "evidence", accessToken: async () => "token_abcdefghijklmnopqrstuvwxyz", fetch });
  await direct.lookup("ci://release", "evidence", 2);
  assert.deepEqual(urls.map((url) => new URL(url).pathname), [
    "/v1/projects/near-prod/locations/us-central1/keyRings/release/cryptoKeys/evidence",
    "/v1/projects/near-prod/locations/us-central1/keyRings/release/cryptoKeys/evidence/cryptoKeyVersions/2",
    "/v1/projects/near-prod/locations/us-central1/keyRings/release/cryptoKeys/evidence/cryptoKeyVersions/2/publicKey",
  ]);
});

test("KMS lookup rejects mapping, identity, transport, and oversized responses", async () => {
  const f = await kmsFixture();
  await assert.rejects(() => client(async () => response(f.body)).lookup("ci://other", "evidence", 2), /mapping/);
  await assert.rejects(() => client(async () => response(f.body), async () => "").lookup("ci://release", "evidence", 2), /identity/);
  await assert.rejects(() => client(async () => response(f.body, { "content-type": "text/plain" })).lookup("ci://release", "evidence", 2), /response invalid/);
  await assert.rejects(() => client(async () => response(f.body, { "content-length": "70000" })).lookup("ci://release", "evidence", 2), /response invalid/);
});

test("KMS lookup rejects wrong resource, protection, algorithm, and malformed PEM", async () => {
  for (const patch of [{ name: "wrong" }, { protectionLevel: "SOFTWARE" }, { algorithm: "RSA_SIGN_PSS_4096_SHA512" }, { pem: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n" }, { pem: "junk\n-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----" }]) {
    const f = await kmsFixture(patch); await assert.rejects(() => client(async () => response(f.body)).lookup("ci://release", "evidence", 2), /response invalid/);
  }
});

test("KMS lookup rejects a missing or mismatched public-key integrity checksum", async () => {
  for (const pemCrc32c of [undefined, "0"]) {
    const f = await kmsFixture({ pemCrc32c });
    await assert.rejects(() => client(async () => response(f.body)).lookup("ci://release", "evidence", 2), /response invalid/);
  }
});

test("KMS network and token failures redact provider details", async () => {
  await assert.rejects(() => client(async () => { throw new Error("private-network"); }).lookup("ci://release", "evidence", 2), (error) => !error.message.includes("private-network"));
  await assert.rejects(() => client(async () => response({}), async () => { throw new Error("private-token"); }).lookup("ci://release", "evidence", 2), (error) => !error.message.includes("private-token"));
});
