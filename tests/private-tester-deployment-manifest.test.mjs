import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalPrivateTesterDeploymentClaims,
  canonicalPrivateTesterReleaseOperation,
  composePrivateTesterDeploymentManifest,
  parsePrivateTesterDeploymentManifest,
  privateTesterDeploymentManifestSignedBytes,
  verifyPrivateTesterDeploymentManifest,
  verifyPrivateTesterDeploymentManifestSignature,
} from "../lib/private-tester-deployment-manifest.ts";
import { composePrivateTesterDeploymentManifestFile, writePrivateTesterDeploymentManifestExclusive } from "../scripts/compose-private-tester-deployment-manifest.ts";
import { CloudKmsEvidenceSigner } from "../lib/release-evidence-adapters.ts";

const now = Date.parse("2026-08-15T12:00:00.000Z");
const principal = "ci://github/nearyou/private-tester-deployment";
const keyId = "private-tester-deployment";
const accountId = "1".repeat(32);
const observed = () => ({
  schemaVersion: 1,
  principal,
  keyId,
  keyVersion: 7,
  releaseId: "rel_20260815_private_01",
  projectId: "appgprj_6a79f8a66eb4819198bb42a2b26addea",
  live: { version: "appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_live", commitSha: "a".repeat(40) },
  rollback: { version: "appgprj_6a79f8a66eb4819198bb42a2b26addea~appgver_rollback", commitSha: "b".repeat(40) },
  resources: [
    { binding: "AUDIO", kind: "r2", resource: `accounts/${accountId}/r2/buckets/nearyou-audio-production` },
    { binding: "DB", kind: "d1", resource: `accounts/${accountId}/d1/database/22222222-2222-4222-8222-222222222222` },
  ],
});
const nonce = "abcdefghijklmnopqrstuv";
const claims = () => composePrivateTesterDeploymentManifest(observed(), () => now, () => nonce);
const hex = (value) => Buffer.from(value).toString("hex");

async function fixture(bits = 3072) {
  const pair = await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const fingerprint = hex(await crypto.subtle.digest("SHA-256", await crypto.subtle.exportKey("spki", pair.publicKey)));
  const value = claims();
  const signature = Buffer.from(await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, pair.privateKey, new TextEncoder().encode(privateTesterDeploymentManifestSignedBytes(value)))).toString("base64url");
  const record = { principal, keyId, version: 7, fingerprint, key: pair.publicKey };
  const trust = [{ principal, keyId, version: 7, fingerprint, status: "active", validFrom: now - 60_000, validUntil: now + 60_000, revokedAt: null, usage: "release-evidence" }];
  return { pair, value, envelope: { claims: value, signature }, record, trust };
}
const verifyOptions = (value, overrides = {}) => ({ now, trust: value.trust, lookupKey: async () => value.record, nonceStore: { consumeDeploymentManifestNonce: async () => true }, ...overrides });
const crc32c = (bytes) => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0x82f63b78 & -(crc & 1)); } return String((crc ^ 0xffffffff) >>> 0); };

test("v2 signs exact Sites-managed logical resources without fabricating physical IDs",()=>{const value={...claims(),schemaVersion:2,resources:[{provider:"sites-managed",binding:"AUDIO",kind:"r2",physicalId:"unknown-managed"},{provider:"sites-managed",binding:"DB",kind:"d1",physicalId:"unknown-managed",tableHash:"c".repeat(64)}]};const parsed=parsePrivateTesterDeploymentManifest(value,now);assert.deepEqual(parsed.resources,value.resources);assert.match(canonicalPrivateTesterDeploymentClaims(parsed),/unknown-managed/);for(const invalid of[{...value,resources:[{...value.resources[0],physicalId:"bucket-guess"},value.resources[1]]},{...value,resources:[value.resources[0],{...value.resources[1],tableHash:"bad"}]},{...value,resources:[{...value.resources[0],extra:true},value.resources[1]]}])assert.throws(()=>parsePrivateTesterDeploymentManifest(invalid,now),/deployment manifest invalid/)});

test("composes exact deployment facts and verifies an RSA-3072 KMS-compatible envelope", async () => {
  const fixtureValue = await fixture();
  let consumed;
  const parsed = await verifyPrivateTesterDeploymentManifest(fixtureValue.envelope, verifyOptions(fixtureValue, { nonceStore: { consumeDeploymentManifestNonce: async (metadata) => (consumed = metadata, true) } }));
  assert.deepEqual(parsed, fixtureValue.value);
  assert.equal(parsed.live.commitSha, observed().live.commitSha);
  assert.equal(parsed.rollback.commitSha, observed().rollback.commitSha);
  assert.equal(parsed.expiresAt - parsed.issuedAt, 15 * 60_000);
  assert.equal(consumed.keyVersion, 7);
  assert.equal(consumed.canonicalClaims, canonicalPrivateTesterDeploymentClaims(parsed));
  assert.match(consumed.claimsDigest, /^[a-f0-9]{64}$/);
  const domainDigest = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(privateTesterDeploymentManifestSignedBytes(parsed))));
  const undomainedDigest = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalPrivateTesterDeploymentClaims(parsed))));
  assert.equal(consumed.claimsDigest, domainDigest);
  assert.notEqual(consumed.claimsDigest, undomainedDigest);
});

test("uses the existing exact-version KMS signer with digest and signature CRC checks", async () => {
  const fixtureValue = await fixture();
  const signed = privateTesterDeploymentManifestSignedBytes(fixtureValue.value);
  const versionedKeyName = "projects/near-prod/locations/us-central1/keyRings/release/cryptoKeys/evidence/cryptoKeyVersions/7";
  const signer = new CloudKmsEvidenceSigner({
    versionedKeyName,
    accessToken: async () => "token_abcdefghijklmnopqrstuvwxyz",
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signed)));
      assert.equal(request.digest.sha256, Buffer.from(digest).toString("base64"));
      assert.equal(request.digestCrc32c, crc32c(digest));
      const signature = new Uint8Array(await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, fixtureValue.pair.privateKey, new TextEncoder().encode(signed)));
      return new Response(JSON.stringify({ name: versionedKeyName, signature: Buffer.from(signature).toString("base64"), signatureCrc32c: crc32c(signature), verifiedDigestCrc32c: true }), { status: 200 });
    },
  });
  const signature = await signer.sign(signed);
  assert.equal(Buffer.from(signature, "base64url").byteLength, 384);
  assert.deepEqual(await verifyPrivateTesterDeploymentManifestSignature({ claims: fixtureValue.value, signature }, now, fixtureValue.record), fixtureValue.value);
});

test("production composer accepts only a canonical bounded operation file and locally verifies KMS output", async () => {
  const fixtureValue = await fixture(), directory = await mkdtemp(join(tmpdir(), "private-tester-compose-")), input = join(directory, "operation.json"), output = join(directory, "manifest.json");
  const operation = observed(), canonicalOperation = canonicalPrivateTesterReleaseOperation(operation), expectedClaims = claims(), signedClaims = privateTesterDeploymentManifestSignedBytes(expectedClaims);
  const versionedKeyName = "projects/near-prod/locations/us-central1/keyRings/release/cryptoKeys/evidence/cryptoKeyVersions/7", keyName = versionedKeyName.replace(/\/cryptoKeyVersions\/7$/, "");
  const encoded = Buffer.from(await crypto.subtle.exportKey("spki", fixtureValue.pair.publicKey)).toString("base64"), pem = `-----BEGIN PUBLIC KEY-----\n${encoded.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----\n`;
  const response = (value) => { const body = JSON.stringify(value); return new Response(body, { status: 200, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } }); };
  let metadataCalls = 0;
  const fetch = async (url, init = {}) => {
    if (url.startsWith("http://metadata.google.internal")) { metadataCalls += 1; return response({ access_token: "token_abcdefghijklmnopqrstuvwxyz", expires_in: 300 }); }
    assert.equal(init.headers.authorization, "Bearer token_abcdefghijklmnopqrstuvwxyz");
    if (url.endsWith(":asymmetricSign")) {
      const request = JSON.parse(init.body), digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signedClaims)));
      assert.equal(request.digest.sha256, Buffer.from(digest).toString("base64"));
      const signature = new Uint8Array(await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, fixtureValue.pair.privateKey, new TextEncoder().encode(signedClaims)));
      return response({ name: versionedKeyName, signature: Buffer.from(signature).toString("base64"), signatureCrc32c: crc32c(signature), verifiedDigestCrc32c: true });
    }
    if (url.endsWith("/cryptoKeys/evidence")) return response({ name: keyName, purpose: "ASYMMETRIC_SIGN" });
    if (url.endsWith("/cryptoKeyVersions/7")) return response({ name: versionedKeyName, state: "ENABLED", algorithm: "RSA_SIGN_PSS_3072_SHA256", protectionLevel: "HSM" });
    return response({ name: versionedKeyName, pem, pemCrc32c: crc32c(new TextEncoder().encode(pem)), algorithm: "RSA_SIGN_PSS_3072_SHA256", protectionLevel: "HSM" });
  };
  const environment = { KMS_PROJECT: "near-prod", KMS_LOCATION: "us-central1", KMS_KEY_RING: "release", KMS_KEY: "evidence", EVIDENCE_PRINCIPAL: principal, EVIDENCE_KEY_ID: keyId, EVIDENCE_KEY_VERSION: "7" };
  try {
    await writeFile(input, `${canonicalOperation}\n`, { flag: "wx" });
    const envelope = await composePrivateTesterDeploymentManifestFile(input, output, environment, { fetch, now: () => now, nonce: () => nonce });
    assert.deepEqual(envelope.claims, expectedClaims);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), envelope);
    assert.equal(metadataCalls, 1);
    const duplicate = join(directory, "duplicate.json");
    await writeFile(duplicate, canonicalOperation.replace('{"keyId":', '{"schemaVersion":1,"keyId":'), { flag: "wx" });
    await assert.rejects(() => composePrivateTesterDeploymentManifestFile(duplicate, join(directory, "duplicate-output.json"), environment, { fetch, now: () => now, nonce: () => nonce }), /input invalid/);
    const link = join(directory, "operation-link.json");
    await symlink(input, link);
    await assert.rejects(() => composePrivateTesterDeploymentManifestFile(link, join(directory, "link-output.json"), environment, { fetch, now: () => now, nonce: () => nonce }), /input invalid/);
    const oversized = join(directory, "oversized.json");
    await writeFile(oversized, "x".repeat(16 * 1024 + 1), { flag: "wx" });
    await assert.rejects(() => composePrivateTesterDeploymentManifestFile(oversized, join(directory, "oversized-output.json"), environment, { fetch, now: () => now, nonce: () => nonce }), /input invalid/);
    await assert.rejects(() => composePrivateTesterDeploymentManifestFile(directory, join(directory, "directory-output.json"), environment, { fetch, now: () => now, nonce: () => nonce }), /input invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects wrong release relationships and nonexact provider resources", () => {
  const base = claims();
  const invalid = [
    { ...base, live: { ...base.live, commitSha: "c".repeat(39) } },
    { ...base, rollback: { ...base.rollback, commitSha: "D".repeat(40) } },
    { ...base, rollback: { ...base.rollback, commitSha: base.live.commitSha } },
    { ...base, rollback: { ...base.rollback, version: base.live.version } },
    { ...base, live: { ...base.live, version: "appgprj_wrong~appgver_live" } },
    { ...base, resources: [base.resources[0], base.resources[0]] },
    { ...base, resources: [{ ...base.resources[0], resource: "r2/buckets/nearyou-audio-production" }, base.resources[1]] },
    { ...base, resources: [{ ...base.resources[0], resource: `accounts/${accountId}/r2/buckets/nearyou.audio.production` }, base.resources[1]] },
    { ...base, resources: [base.resources[0], { ...base.resources[1], resource: `accounts/${"2".repeat(32)}/d1/database/22222222-2222-4222-8222-222222222222` }] },
  ];
  for (const value of invalid) assert.throws(() => parsePrivateTesterDeploymentManifest(value, now), /deployment manifest invalid/);
});

test("rejects stale, future, expired, and over-fifteen-minute claims", () => {
  const base = claims();
  for (const value of [
    { ...base, issuedAt: now - 300_001, notBefore: now - 300_001, expiresAt: now + 1 },
    { ...base, issuedAt: now + 30_001, notBefore: now, expiresAt: now + 60_000 },
    { ...base, expiresAt: now },
    { ...base, expiresAt: base.issuedAt + 15 * 60_000 + 1 },
  ]) assert.throws(() => parsePrivateTesterDeploymentManifest(value, now), /deployment manifest invalid/);
});

test("rejects weak or wrong keys, tamper, and nonce replay", async () => {
  const fixtureValue = await fixture();
  await assert.rejects(() => verifyPrivateTesterDeploymentManifest({ ...fixtureValue.envelope, claims: { ...fixtureValue.value, releaseId: "rel_20260815_private_02" } }, verifyOptions(fixtureValue)), /signature/);
  await assert.rejects(() => verifyPrivateTesterDeploymentManifest({ ...fixtureValue.envelope, claims: { ...fixtureValue.value, live: { ...fixtureValue.value.live, commitSha: "c".repeat(40) } } }, verifyOptions(fixtureValue)), /signature/);
  await assert.rejects(() => verifyPrivateTesterDeploymentManifest({ ...fixtureValue.envelope, claims: { ...fixtureValue.value, rollback: { ...fixtureValue.value.rollback, commitSha: "d".repeat(40) } } }, verifyOptions(fixtureValue)), /signature/);
  await assert.rejects(() => verifyPrivateTesterDeploymentManifest(fixtureValue.envelope, verifyOptions(fixtureValue, { lookupKey: async () => ({ ...fixtureValue.record, version: 8 }) })), /key invalid/);
  await assert.rejects(() => verifyPrivateTesterDeploymentManifest(fixtureValue.envelope, verifyOptions(fixtureValue, { lookupKey: async () => ({ ...fixtureValue.record, fingerprint: "0".repeat(64) }) })), /key invalid/);
  const weak = await fixture(2048);
  await assert.rejects(() => verifyPrivateTesterDeploymentManifest(weak.envelope, verifyOptions(weak)), /key invalid/);
  const crossDomainSignature = Buffer.from(await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, fixtureValue.pair.privateKey, new TextEncoder().encode(`release-evidence/v1\n${canonicalPrivateTesterDeploymentClaims(fixtureValue.value)}`))).toString("base64url");
  await assert.rejects(() => verifyPrivateTesterDeploymentManifest({ claims: fixtureValue.value, signature: crossDomainSignature }, verifyOptions(fixtureValue)), /signature invalid/);
  await assert.rejects(() => verifyPrivateTesterDeploymentManifest(fixtureValue.envelope, verifyOptions(fixtureValue, { nonceStore: { consumeDeploymentManifestNonce: async () => false } })), /replay rejected/);
  let committed = false;
  const consumeNonce = async () => { if (!committed) { committed = true; throw new Error("lost response"); } return false; };
  await assert.rejects(() => verifyPrivateTesterDeploymentManifest(fixtureValue.envelope, verifyOptions(fixtureValue, { nonceStore: { consumeDeploymentManifestNonce: consumeNonce } })), /nonce store failed/);
  await assert.rejects(() => verifyPrivateTesterDeploymentManifest(fixtureValue.envelope, verifyOptions(fixtureValue, { nonceStore: { consumeDeploymentManifestNonce: consumeNonce } })), /replay rejected/);
});

test("composer opens one regular bounded fact file with no-follow semantics", async () => {
  const source = await readFile(new URL("../scripts/compose-private-tester-deployment-manifest.ts", import.meta.url), "utf8");
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /\.isFile\(\)/);
  assert.match(source, /MAX_INPUT_BYTES\s*\+\s*1/);
  assert.match(source, /handle\.read\(/);
});

test("rejects extra, hidden, accessor, symbol, and duplicate resource properties", () => {
  const values = [];
  values.push({ ...claims(), extra: true });
  const hidden = claims(); Object.defineProperty(hidden, "extra", { value: true }); values.push(hidden);
  const accessor = claims(); Object.defineProperty(accessor, "releaseId", { enumerable: true, get: () => observed().releaseId }); values.push(accessor);
  const symbol = claims(); symbol[Symbol("extra")] = true; values.push(symbol);
  values.push({ ...claims(), resources: [claims().resources[0], { ...claims().resources[1], binding: "AUDIO" }] });
  for (const value of values) assert.throws(() => parsePrivateTesterDeploymentManifest(value, now), /deployment manifest invalid/);
});

test("exclusive manifest output converges after a committed response is lost", async () => {
  const directory = await mkdtemp(join(tmpdir(), "private-tester-deployment-"));
  const output = join(directory, "manifest.json");
  const envelope = (await fixture()).envelope;
  let lose = true;
  const io = {
    writeFile: async (path, body, options) => {
      await writeFile(path, body, options);
      if (lose) { lose = false; throw new Error("lost response"); }
    },
    readFile,
  };
  try {
    assert.deepEqual(await writePrivateTesterDeploymentManifestExclusive(output, envelope, io), envelope);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), envelope);
    assert.deepEqual(await writePrivateTesterDeploymentManifestExclusive(output, envelope, io), envelope);
    await assert.rejects(() => writePrivateTesterDeploymentManifestExclusive(output, { ...envelope, signature: `A${envelope.signature.slice(1)}` }, io), /output conflict/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
