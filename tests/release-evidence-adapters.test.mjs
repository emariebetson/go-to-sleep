import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CloudKmsPublicKeyClient, PostgresNonceMaintenance, PostgresNonceStore, PostgresPrivateTesterDeploymentManifestNonceStore } from "../lib/release-evidence-adapters.ts";

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
  assert.match(migration, /CREATE ROLE nearyou_release_policy_owner NOLOGIN NOINHERIT NOBYPASSRLS/);
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

const nonceInput = { nonce: "abcdefghijklmnopqrstuv", claimsDigest: "a".repeat(64), principal: "ci://release", keyId: "key-1", keyVersion: 1, releaseId: "rel_1", expiresAt: Date.now() + 60_000, canonicalClaims:'{"releaseId":"rel_1"}' };
test("nonce store converges after a committed response is lost", async () => {
  let inserted = false; let lose = true;
  const db = { query: async () => { if (!inserted) { inserted = true; if (lose) { lose = false; throw new Error("lost response"); } return { rows: [{ consumed: true }] }; } return { rows: [{ consumed: false }] }; } };
  const store = new PostgresNonceStore(db);
  await assert.rejects(() => store.consume(nonceInput), /lost/);
  assert.equal(await store.consume(nonceInput), false);
});

test("concurrent nonce consumption admits exactly one and cleanup is bounded", async () => {
  let inserted = false;
  const db = { query: async (sql, args) => { if (sql.includes("consume_release_evidence")) { await new Promise((resolve) => setTimeout(resolve, 5)); if (inserted) return { rows: [{ consumed: false }] }; inserted = true; return { rows: [{ consumed: true }] }; } assert.deepEqual(args, [25]); return { rows: [{ removed: 25 }] }; } };
  const store = new PostgresNonceStore(db); const outcomes = await Promise.all([store.consume(nonceInput), store.consume(nonceInput)]); assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(await new PostgresNonceMaintenance(db).cleanup(25), 25); await assert.rejects(() => new PostgresNonceMaintenance(db).cleanup(1001), /limit/);
});

test("verified evidence consumption durably binds the exact signed claims projection", async () => {
  const runtime=readFileSync(new URL("../postgres/migrations/0003_cutover_runtime.sql",import.meta.url),"utf8");
  assert.match(runtime,/claims_projection jsonb/);
  assert.match(runtime,/consume_release_evidence\(p_nonce text,p_digest text,p_canonical text/);
  assert.match(runtime,/encode\(nearyou_crypto\.digest\(p_canonical,'sha256'\),'hex'\)<>p_digest/);
  assert.match(runtime,/REVOKE ALL ON FUNCTION nearyou\.consume_evidence_nonce\(text,text,text,text,integer,text,timestamptz\) FROM nearyou_release_verifier/);
  const canonical='{"releaseId":"release-1"}';let args;
  const store=new PostgresNonceStore({query:async(_sql,input)=>{args=input;return{rows:[{consumed:true}]}}});
  assert.equal(await store.consume({...nonceInput,canonicalClaims:canonical}),true);
  assert.equal(args[7],canonical);
});

test("deployment manifest nonce adapter calls only its purpose-specific atomic function", async () => {
  let sql, args;
  const store = new PostgresPrivateTesterDeploymentManifestNonceStore({ query: async (statement, values) => { sql = statement; args = values; return { rows: [{ consumed: true }] }; } });
  const input = { ...nonceInput, releaseId: "rel_20260815_private_01", expiresAt: 1_800_000_900_000, canonicalClaims: '{"schemaVersion":1}' };
  assert.equal(await store.consumeDeploymentManifestNonce(input), true);
  assert.match(sql, /consume_private_tester_deployment_manifest/);
  assert.doesNotMatch(sql, /consume_release_evidence/);
  assert.deepEqual(args, ["private-tester-deployment-manifest/v1", input.nonce, input.claimsDigest, input.canonicalClaims, input.principal, input.keyId, input.keyVersion, input.releaseId, input.expiresAt]);
  let inserted = false;
  const lost = new PostgresPrivateTesterDeploymentManifestNonceStore({ query: async () => { if (!inserted) { inserted = true; throw new Error("lost response"); } return { rows: [{ consumed: false }] }; } });
  await assert.rejects(() => lost.consumeDeploymentManifestNonce(input), /lost response/);
  assert.equal(await lost.consumeDeploymentManifestNonce(input), false);
});

test("deployment manifest migration binds exact schema, identities, time, replay, and least privilege", () => {
  const sql = readFileSync(new URL("../postgres/migrations/0007_private_tester_deployment_manifest.sql", import.meta.url), "utf8");
  for (const required of [
    "private-tester-deployment-manifest/v1", "consume_private_tester_deployment_manifest", "schemaVersion", "projectId", "live", "rollback", "resources", "notBefore", "issuedAt", "expiresAt", "claims_digest text NOT NULL UNIQUE", "nonce text PRIMARY KEY", "interval '15 minutes'", "statement_timestamp()", "SECURITY DEFINER", "nearyou_crypto.digest", "private_tester_deployment_manifest_immutable",
  ]) assert.match(sql, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sql, /ARRAY\['expiresAt','issuedAt','keyId','keyVersion','live','nonce','notBefore','principal','projectId','releaseId','resources','rollback','schemaVersion'\]/);
  assert.match(sql, /starts_with\(live->>'version',claims->>'projectId'\|\|'~appgver_'\)/);
  assert.match(sql, /starts_with\(rollback->>'version',claims->>'projectId'\|\|'~appgver_'\)/);
  assert.doesNotMatch(sql, /version' NOT LIKE/);
  for (const typed of ["claims->'principal'", "claims->'keyVersion'", "claims->'issuedAt'", "live->'version'", "rollback->'commitSha'", "r2->'resource'", "d1->'resource'"]) assert.match(sql, new RegExp(`jsonb_typeof\\(${typed.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\)`));
  assert.match(sql, /REVOKE ALL ON FUNCTION nearyou\.consume_private_tester_deployment_manifest[\s\S]*FROM PUBLIC,nearyou_app/);
  assert.match(sql, /REVOKE ALL ON FUNCTION nearyou\.consume_private_tester_deployment_manifest[\s\S]*FROM nearyou_release_verifier/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION nearyou\.consume_private_tester_deployment_manifest[^;]*TO nearyou_release_verifier/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE).*private_tester_deployment_manifest_nonces TO nearyou_release_verifier/);
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION nearyou\.consume_release_evidence|ALTER FUNCTION nearyou\.consume_release_evidence/);
  assert.match(sql, /CREATE ROLE nearyou_private_tester_baseline_verifier NOLOGIN NOINHERIT NOBYPASSRLS/);
  assert.match(sql, /GRANT USAGE ON SCHEMA nearyou TO nearyou_private_tester_baseline_verifier/);
  assert.match(sql, /GRANT SELECT ON nearyou\.schema_migrations TO nearyou_private_tester_baseline_verifier/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION nearyou\.consume_private_tester_deployment_manifest[\s\S]*TO nearyou_private_tester_baseline_verifier/);
  assert.match(sql, /REVOKE ALL ON nearyou\.schema_migrations FROM nearyou_rollout_controller/);
  assert.match(sql, /REVOKE ALL ON FUNCTION nearyou\.consume_private_tester_deployment_manifest[\s\S]*FROM nearyou_rollout_controller/);
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE).*nearyou\.(?:product_rollout|release_evidence|private_tester_deployment_manifest_nonces).* TO nearyou_private_tester_baseline_verifier/);
  assert.match(sql, /CREATE FUNCTION nearyou\.assert_private_tester_baseline_verifier\(\) RETURNS TABLE/);
  assert.match(sql, /SECURITY DEFINER SET search_path=pg_catalog,nearyou/);
  assert.match(sql, /session_user::text/);
  assert.match(sql, /current_database\(\)<>'nearyou'/);
  assert.match(sql, /pg_has_role\(session_user,'nearyou_private_tester_baseline_verifier','USAGE'\)/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION nearyou\.assert_private_tester_baseline_verifier\(\) TO nearyou_private_tester_baseline_verifier/);
});

test("deployment manifest SQL time contract accepts allowed skew and rejects invalid lifetimes", () => {
  const sql = readFileSync(new URL("../postgres/migrations/0007_private_tester_deployment_manifest.sql", import.meta.url), "utf8");
  assert.match(sql, /CHECK \(expires_at - issued_at > interval '0 seconds' AND expires_at - issued_at <= interval '15 minutes'\)/);
  assert.doesNotMatch(sql, /expires_at <= consumed_at \+ interval '15 minutes'/);
  assert.doesNotMatch(sql, /expires_at_ms>server_now_ms\+900000/);

  const rejection = sql.match(/IF (not_before_ms>issued_at_ms[\s\S]*?) THEN RETURN false; END IF;/)?.[1];
  assert.ok(rejection, "migration time rejection predicate is executable by this contract test");
  const javascript = rejection
    .replace(/expires_at_ms IS DISTINCT FROM floor\(extract\(epoch FROM p_expiry\)\*1000\)::bigint/g, "expires_at_ms !== p_expiry_ms")
    .replace(/\bOR\b/g, "||");
  assert.doesNotMatch(javascript, /\b(?:AND|IS|FROM|interval)\b/);
  const rejects = Function("not_before_ms", "issued_at_ms", "expires_at_ms", "server_now_ms", "p_expiry_ms", `"use strict"; return Boolean(${javascript});`);
  const serverNow = 1_800_000_000_000;
  const evaluate = ({ issuedAt, notBefore = issuedAt, expiresAt }) => rejects(notBefore, issuedAt, expiresAt, serverNow, expiresAt);

  assert.equal(evaluate({ issuedAt: serverNow + 1, expiresAt: serverNow + 1 + 900_000 }), false, "+1ms composer skew with exact lifetime is valid");
  assert.equal(evaluate({ issuedAt: serverNow + 29_999, expiresAt: serverNow + 29_999 + 900_000 }), false, "+29999ms composer skew with exact lifetime is valid");
  assert.equal(evaluate({ issuedAt: serverNow + 30_001, expiresAt: serverNow + 30_001 + 900_000 }), true, ">30s future issuance is invalid");
  assert.equal(evaluate({ issuedAt: serverNow, expiresAt: serverNow + 900_001 }), true, ">15m signed lifetime is invalid");
  assert.equal(evaluate({ issuedAt: serverNow - 1, expiresAt: serverNow }), true, "expired claims are invalid");
});

test("executable PostgreSQL ACL gate proves controller denial and verifier allowance", () => {
  const sql = readFileSync(new URL("../scripts/private-tester-baseline-acl-gate.sql", import.meta.url), "utf8");
  assert.match(sql, /\\set ON_ERROR_STOP on/);
  assert.match(sql, /has_table_privilege\('nearyou_rollout_controller','nearyou\.schema_migrations','SELECT'\)/);
  assert.match(sql, /has_function_privilege\('nearyou_rollout_controller'.*'EXECUTE'\)/);
  assert.match(sql, /NOT has_schema_privilege\('nearyou_private_tester_baseline_verifier'/);
  assert.match(sql, /NOT has_table_privilege\('nearyou_private_tester_baseline_verifier','nearyou\.schema_migrations','SELECT'\)/);
  assert.match(sql, /mutation ACL widened/);
  assert.match(sql, /SET LOCAL ROLE nearyou_private_tester_baseline_verifier/);
  assert.match(sql, /SELECT id,checksum FROM nearyou\.schema_migrations/);
  assert.match(sql, /SELECT \* FROM nearyou\.assert_private_tester_baseline_verifier\(\)/);
  assert.match(sql, /SELECT \* FROM nearyou\.private_tester_baseline_verifier_identities/);
  assert.match(sql, /\\if :ERROR/);
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
