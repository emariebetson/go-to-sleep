import assert from "node:assert/strict";
import test from "node:test";
import { canonicalEvidence, verifyReleaseEvidence } from "../lib/asymmetric-release-evidence.ts";

const now = 1_800_000_000_000;
const hash = (value) => value.repeat(64);
const releaseId = "rel_1";
const schema = hash("a");
const result = {
  rls: { negativeTests: 20, crossTenantViolations: 0 },
  media: { canaries: 8, failed: 0 },
  restore: { restoredObjects: 100, checksumMismatches: 0 },
  load: { requests: 10000, errorRateBps: 5, p95Ms: 200, maxErrorRateBps: 25, maxP95Ms: 500 },
  accessibility: { checks: 80, violations: 0 },
  security: { critical: 0, high: 0, scanArtifact: hash("e"), penTestArtifact: hash("f") },
  canary: { startedAt: now - 86_401_000, endedAt: now - 1000, heartbeatCount: 1440, deadLetters: 0, completedJobs: 100, failedJobs: 0, reconciliationArtifact:"8".repeat(64),terminalCount:100,terminalDigest:"9".repeat(64),pending:0,outboxDeadLetters:0 },
};
const gate = (kind) => ({ kind, policyVersion: 1, releaseId, schema, artifact: hash("c"), verifiedAt: now - 1000, results: result[kind] });
const productReadiness=["nearstory","nearfamily","nearlegacy"].map(product=>({product,environment:"production",region:"us-central1",releaseId,artifact:hash("7"),imageDigest:hash("8"),expiresAt:now+60_000,controllerMapping:{verified:true,artifact:hash("9"),verifiedAt:now-1000},secretVersions:{runtime:"projects/prod/secrets/runtime/versions/7"},capacity:{queueDepth:1,maxQueueDepth:10,errorRateBps:1,maxErrorRateBps:10,soakStartedAt:now-3700000,soakEndedAt:now-1000},probes:Object.fromEntries((product==="nearfamily"?["identity","member","entitlement","invite","privacy","capacityRemediation"]:["worker","scheduler","processor"]).map(name=>[name,{identity:`probe:${name}`,passed:true,verifiedAt:now-1000}])),mobilePlatforms:product==="nearfamily"?["ios","android"]:[]}));
const claims = { version: 1, principal: "ci://github/nearyou/release", keyId: "kms-release", keyVersion: 2, releaseId, schema, backfill: hash("b"), highWater: 42, fence: 7, notBefore: now - 70_000, issuedAt: now - 500, expiresAt: now + 60_000, productReadiness, nonce: "abcdefghijklmnopqrstuv", gates: Object.fromEntries(Object.keys(result).map((kind) => [kind, gate(kind)])), shadow: { kind: "shadow", policyVersion: 1, releaseId, schema, artifact: hash("d"), startedAt: now - 65_000, endedAt: now - 1000, sourceChecksum: hash("b"), targetChecksum: hash("b"), sampleCount: 100, observedRows: 100, mismatchCount: 0 } };
const hex = (buffer) => Buffer.from(buffer).toString("hex");
async function fixture(bits = 3072) {
  const pair = await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const fingerprint = hex(await crypto.subtle.digest("SHA-256", await crypto.subtle.exportKey("spki", pair.publicKey)));
  const record = { principal: claims.principal, keyId: claims.keyId, version: claims.keyVersion, fingerprint, key: pair.publicKey };
  const trust = [{ principal: claims.principal, keyId: claims.keyId, version: claims.keyVersion, fingerprint, status: "active", validFrom: now - 10_000, validUntil: now + 10_000, revokedAt: null, usage: "release-evidence" }];
  const signature = Buffer.from(await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, pair.privateKey, new TextEncoder().encode(canonicalEvidence(claims)))).toString("base64url");
  return { pair, record, trust, envelope: { claims, signature } };
}
const options = (f, extra = {}) => ({ now, trust: f.trust, lookupKey: async () => f.record, consumeNonce: async () => true, ...extra });

test("accepts exact RSA-3072 evidence and binds key version into nonce metadata", async () => {
  const f = await fixture(); let metadata;
  assert.equal(await verifyReleaseEvidence(f.envelope, options(f, { consumeNonce: async (value) => (metadata = value, true) })), true);
  assert.equal(metadata.keyVersion, claims.keyVersion); assert.match(metadata.claimsDigest, /^[a-f0-9]{64}$/);
});

test("rejects tamper, wrong principal, key version, fingerprint, and RSA-2048", async () => {
  const f = await fixture();
  await assert.rejects(() => verifyReleaseEvidence({ ...f.envelope, claims: { ...claims, highWater: 43 } }, options(f)), /signature/);
  await assert.rejects(() => verifyReleaseEvidence({ ...f.envelope, claims: { ...claims, keyVersion: 3 } }, options(f)), /untrusted/);
  await assert.rejects(() => verifyReleaseEvidence(f.envelope, options(f, { lookupKey: async () => ({ ...f.record, fingerprint: hash("0") }) })), /key invalid/);
  const weak = await fixture(2048); await assert.rejects(() => verifyReleaseEvidence(weak.envelope, options(weak)), /key invalid/);
});

test("validates every trust lifecycle record and exact rotation tuple", async () => {
  const f = await fixture();
  const malformedUnrelated = { ...f.trust[0], principal: "other", version: 0 };
  await assert.rejects(() => verifyReleaseEvidence(f.envelope, options(f, { trust: [...f.trust, malformedUnrelated] })), /configuration/);
  await assert.rejects(() => verifyReleaseEvidence(f.envelope, options(f, { trust: [...f.trust, f.trust[0]] })), /configuration/);
  const revoked = { ...f.trust[0], status: "revoked", revokedAt: now - 1 };
  await assert.rejects(() => verifyReleaseEvidence(f.envelope, options(f, { trust: [revoked] })), /untrusted/);
  const retiring = { ...f.trust[0], status: "retiring" }; assert.equal(await verifyReleaseEvidence(f.envelope, options(f, { trust: [retiring] })), true);
});

test("enforces evidence freshness, bounded lifetime, and canonical signatures", async () => {
  const f = await fixture();
  await assert.rejects(() => verifyReleaseEvidence({ ...f.envelope, claims: { ...claims, expiresAt: now + 3_600_000 } }, options(f)), /freshness|product readiness/);
  await assert.rejects(() => verifyReleaseEvidence({ ...f.envelope, claims: { ...claims, notBefore: now + 60_000, issuedAt: now + 60_000 } }, options(f)), /gate|freshness|product readiness/);
  await assert.rejects(() => verifyReleaseEvidence({ ...f.envelope, signature: `${f.envelope.signature}=` }, options(f)), /malformed/);
  await assert.rejects(() => verifyReleaseEvidence({ ...f.envelope, signature: "AAAA" }, options(f)), /malformed/);
});

test("typed artifacts cannot be swapped and unsafe result numbers are rejected", () => {
  assert.throws(() => canonicalEvidence({ ...claims, gates: { ...claims.gates, media: { ...claims.gates.rls } } }), /gate/);
  assert.throws(() => canonicalEvidence({ ...claims, gates: { ...claims.gates, load: { ...claims.gates.load, results: { ...claims.gates.load.results, p95Ms: Number.NaN } } } }), /gate/);
  assert.throws(() => canonicalEvidence({ ...claims, gates: { ...claims.gates, security: { ...claims.gates.security, results: { ...claims.gates.security.results, high: 1 } } } }), /gate/);
  assert.throws(() => canonicalEvidence({ ...claims, shadow: { ...claims.shadow, targetChecksum: hash("9") } }), /shadow/);
  const family=claims.productReadiness.find(item=>item.product==="nearfamily"),{capacityRemediation,...withoutCapacity}=family.probes;
  assert.ok(capacityRemediation);assert.throws(()=>canonicalEvidence({...claims,productReadiness:claims.productReadiness.map(item=>item.product==="nearfamily"?{...item,probes:withoutCapacity}:item)}),/product readiness/);
});

test("rejects null prototypes, accessors, cycles, extra fields, and oversized claims", () => {
  assert.throws(() => canonicalEvidence(Object.assign(Object.create(null), claims)), /schema/);
  const accessor = { ...claims }; Object.defineProperty(accessor, "releaseId", { enumerable: true, get: () => releaseId }); assert.throws(() => canonicalEvidence(accessor), /schema/);
  const cycle = {}; cycle.self = cycle; assert.throws(() => canonicalEvidence({ ...claims, extra: cycle }), /schema/);
  assert.throws(() => canonicalEvidence({ ...claims, releaseId: "x".repeat(300_000) }), /claims/);
});

test("redacts provider and nonce-store errors", async () => {
  const f = await fixture();
  await assert.rejects(() => verifyReleaseEvidence(f.envelope, options(f, { lookupKey: async () => { throw new Error("private-token"); } })), (error) => !error.message.includes("private-token"));
  await assert.rejects(() => verifyReleaseEvidence(f.envelope, options(f, { consumeNonce: async () => { throw new Error("private-row"); } })), (error) => !error.message.includes("private-row"));
});

test("atomic nonce adapter permits exactly one concurrent verification", async () => {
  const f = await fixture(); let used = false;
  const consumeNonce = async () => { await new Promise((resolve) => setTimeout(resolve, 5)); if (used) return false; used = true; return true; };
  const outcomes = await Promise.allSettled([verifyReleaseEvidence(f.envelope, options(f, { consumeNonce })), verifyReleaseEvidence(f.envelope, options(f, { consumeNonce }))]);
  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
});
