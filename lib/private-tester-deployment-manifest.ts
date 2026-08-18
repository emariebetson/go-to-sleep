import type { KeyRecord, Trust } from "./asymmetric-release-evidence";

const encoder = new TextEncoder();
const CLAIM_KEYS = ["schemaVersion", "principal", "keyId", "keyVersion", "releaseId", "projectId", "live", "rollback", "resources", "notBefore", "issuedAt", "expiresAt", "nonce"];
const OPERATION_KEYS = ["schemaVersion", "principal", "keyId", "keyVersion", "releaseId", "projectId", "live", "rollback", "resources"];
const VERSION_KEYS = ["version", "commitSha"];
const RESOURCE_KEYS = ["binding", "kind", "resource"];
const MANAGED_AUDIO_KEYS = ["provider", "binding", "kind", "physicalId"];
const MANAGED_DB_KEYS = ["provider", "binding", "kind", "physicalId", "tableHash"];
const MANAGED_V3_AUDIO_KEYS = ["provider", "binding", "kind", "physicalId", "archiveSha256", "deploymentId", "buildId"];
const MANAGED_V3_DB_KEYS = ["provider", "binding", "kind", "physicalId", "buildId", "schemaDigest", "schemaObjectCount", "migrationDigest", "migrationCount"];
const ENVELOPE_KEYS = ["claims", "signature"];
const TRUST_KEYS = ["principal", "keyId", "version", "fingerprint", "status", "validFrom", "validUntil", "revokedAt", "usage"];
const KEY_RECORD_KEYS = ["principal", "keyId", "version", "fingerprint", "key"];
const RELEASE_ID = /^rel_[A-Za-z0-9_-]{8,100}$/;
const CLAIM_ID = /^[A-Za-z0-9_:/.@-]{3,200}$/;
const PROJECT = /^appgprj_[A-Za-z0-9_-]{8,128}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const ACCOUNT = /^[a-f0-9]{32}$/;
const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const R2_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEPLOYMENT_ID = /^appgdep_[A-Za-z0-9_-]{8,152}$/;
const MAX_LIFETIME_MS = 15 * 60_000;
const MAX_AGE_MS = 5 * 60_000;
const MAX_FUTURE_MS = 30_000;
const MAX_CANONICAL_BYTES = 16 * 1024;
export const PRIVATE_TESTER_DEPLOYMENT_MANIFEST_DOMAIN = "private-tester-deployment-manifest/v1";

export type PrivateTesterDeploymentVersion = { version: string; commitSha: string };
export type PrivateTesterDeploymentResource =
  | { binding: "AUDIO"; kind: "r2"; resource: string }
  | { binding: "DB"; kind: "d1"; resource: string }
  | { provider: "sites-managed"; binding: "AUDIO"; kind: "r2"; physicalId: "unknown-managed" }
  | { provider: "sites-managed"; binding: "DB"; kind: "d1"; physicalId: "unknown-managed"; tableHash: string }
  | { provider: "sites-managed"; binding: "AUDIO"; kind: "r2"; physicalId: "unknown-managed"; archiveSha256: string; deploymentId: string; buildId: string }
  | { provider: "sites-managed"; binding: "DB"; kind: "d1"; physicalId: "unknown-managed"; buildId: string; schemaDigest: string; schemaObjectCount: number; migrationDigest: string; migrationCount: number };
export type ObservedPrivateTesterReleaseOperation = {
  schemaVersion: 1 | 2 | 3;
  principal: string;
  keyId: string;
  keyVersion: number;
  releaseId: string;
  projectId: string;
  live: PrivateTesterDeploymentVersion;
  rollback: PrivateTesterDeploymentVersion;
  resources: [PrivateTesterDeploymentResource, PrivateTesterDeploymentResource];
};
export type PrivateTesterDeploymentClaims = ObservedPrivateTesterReleaseOperation & {
  notBefore: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};
export type PrivateTesterDeploymentEnvelope = { claims: PrivateTesterDeploymentClaims; signature: string };
export type PrivateTesterDeploymentNonce = { nonce: string; claimsDigest: string; principal: string; keyId: string; keyVersion: number; releaseId: string; expiresAt: number; canonicalClaims: string };

function invalid(): never { throw new Error("private tester deployment manifest invalid"); }
function integer(value: unknown, min = 0): value is number { return Number.isSafeInteger(value) && Number(value) >= min; }
function exactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) return false;
  const expected = new Set(keys);
  return ownKeys.every((key) => {
    if (typeof key !== "string" || !expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value") && !descriptor.get && !descriptor.set;
  });
}
function exactArray(value: unknown, length: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys[length] !== "length") return false;
  for (let index = 0; index < length; index += 1) {
    if (keys[index] !== String(index)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") || descriptor.get || descriptor.set) return false;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  return !!lengthDescriptor && Object.hasOwn(lengthDescriptor, "value") && lengthDescriptor.enumerable === false;
}
function parseVersion(value: unknown, projectId: string): PrivateTesterDeploymentVersion {
  if (!exactRecord(value, VERSION_KEYS) || typeof value.version !== "string" || value.version.length > 300 || !value.version.startsWith(`${projectId}~appgver_`) || !/^appgprj_[A-Za-z0-9_-]+~appgver_[A-Za-z0-9_-]+$/.test(value.version) || typeof value.commitSha !== "string" || !COMMIT.test(value.commitSha)) invalid();
  return { version: value.version, commitSha: value.commitSha };
}
function parseResources(value: unknown, schemaVersion: 1 | 2 | 3): [PrivateTesterDeploymentResource, PrivateTesterDeploymentResource] {
  if (!exactArray(value, 2)) invalid();
  if (schemaVersion === 3) { const audio=value[0],database=value[1]; if(!exactRecord(audio,MANAGED_V3_AUDIO_KEYS)||audio.provider!=="sites-managed"||audio.binding!=="AUDIO"||audio.kind!=="r2"||audio.physicalId!=="unknown-managed"||typeof audio.archiveSha256!=="string"||!HASH.test(audio.archiveSha256)||typeof audio.deploymentId!=="string"||!DEPLOYMENT_ID.test(audio.deploymentId)||typeof audio.buildId!=="string"||!BUILD_ID.test(audio.buildId)||!exactRecord(database,MANAGED_V3_DB_KEYS)||database.provider!=="sites-managed"||database.binding!=="DB"||database.kind!=="d1"||database.physicalId!=="unknown-managed"||database.buildId!==audio.buildId||typeof database.schemaDigest!=="string"||!HASH.test(database.schemaDigest)||!integer(database.schemaObjectCount,1)||Number(database.schemaObjectCount)>10_000_000||typeof database.migrationDigest!=="string"||!HASH.test(database.migrationDigest)||!integer(database.migrationCount,1)||Number(database.migrationCount)>10_000_000)invalid();return[audio as PrivateTesterDeploymentResource,database as PrivateTesterDeploymentResource]}
  if (schemaVersion === 2) { const audio=value[0],database=value[1]; if(!exactRecord(audio,MANAGED_AUDIO_KEYS)||audio.provider!=="sites-managed"||audio.binding!=="AUDIO"||audio.kind!=="r2"||audio.physicalId!=="unknown-managed"||!exactRecord(database,MANAGED_DB_KEYS)||database.provider!=="sites-managed"||database.binding!=="DB"||database.kind!=="d1"||database.physicalId!=="unknown-managed"||typeof database.tableHash!=="string"||!HASH.test(database.tableHash))invalid(); return [audio as PrivateTesterDeploymentResource,database as PrivateTesterDeploymentResource]; }
  const parsed = value.map((entry) => {
    if (!exactRecord(entry, RESOURCE_KEYS) || typeof entry.resource !== "string" || entry.resource.length > 512) invalid();
    if (entry.binding === "AUDIO" && entry.kind === "r2") {
      const match = entry.resource.match(/^accounts\/([a-f0-9]{32})\/r2\/buckets\/([^/]+)$/);
      if (!match || !ACCOUNT.test(match[1]) || !R2_BUCKET.test(match[2])) invalid();
      return { binding: "AUDIO", kind: "r2", resource: entry.resource } as const;
    }
    if (entry.binding === "DB" && entry.kind === "d1") {
      const match = entry.resource.match(/^accounts\/([a-f0-9]{32})\/d1\/database\/([^/]+)$/);
      if (!match || !ACCOUNT.test(match[1]) || !D1_ID.test(match[2])) invalid();
      return { binding: "DB", kind: "d1", resource: entry.resource } as const;
    }
    return invalid();
  });
  if (parsed[0].binding !== "AUDIO" || parsed[1].binding !== "DB" || parsed[0].resource.split("/")[1] !== parsed[1].resource.split("/")[1]) invalid();
  return parsed as [PrivateTesterDeploymentResource, PrivateTesterDeploymentResource];
}
function parseOperation(input: unknown, keys: string[]): ObservedPrivateTesterReleaseOperation {
  if (!exactRecord(input, keys) || (input.schemaVersion !== 1 && input.schemaVersion !== 2 && input.schemaVersion !== 3) || typeof input.principal !== "string" || !CLAIM_ID.test(input.principal) || typeof input.keyId !== "string" || !CLAIM_ID.test(input.keyId) || !integer(input.keyVersion, 1) || typeof input.releaseId !== "string" || !RELEASE_ID.test(input.releaseId) || typeof input.projectId !== "string" || !PROJECT.test(input.projectId)) invalid();
  const live = parseVersion(input.live, input.projectId), rollback = parseVersion(input.rollback, input.projectId), resources = parseResources(input.resources,input.schemaVersion);
  if (live.version === rollback.version || live.commitSha === rollback.commitSha) invalid();
  return { schemaVersion: input.schemaVersion, principal: input.principal, keyId: input.keyId, keyVersion: input.keyVersion, releaseId: input.releaseId, projectId: input.projectId, live, rollback, resources };
}
function parseClaims(input: unknown): PrivateTesterDeploymentClaims {
  const operation = parseOperation(input, CLAIM_KEYS);
  const value = input as Record<string, unknown>;
  if (!integer(value.notBefore) || !integer(value.issuedAt) || !integer(value.expiresAt) || typeof value.nonce !== "string" || !NONCE.test(value.nonce)) invalid();
  const notBefore = value.notBefore, issuedAt = value.issuedAt, expiresAt = value.expiresAt;
  if (notBefore > issuedAt || issuedAt >= expiresAt || expiresAt - issuedAt > MAX_LIFETIME_MS) invalid();
  return { ...operation, notBefore, issuedAt, expiresAt, nonce: value.nonce };
}

export function parsePrivateTesterDeploymentManifest(input: unknown, nowMs: number): PrivateTesterDeploymentClaims {
  if (!integer(nowMs)) invalid();
  const claims = parseClaims(input);
  if (claims.notBefore > nowMs + MAX_FUTURE_MS || claims.issuedAt > nowMs + MAX_FUTURE_MS || nowMs - claims.issuedAt > MAX_AGE_MS || claims.expiresAt <= nowMs) invalid();
  return claims;
}

function stable(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value))) return value;
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") invalid();
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)]));
}
export function canonicalPrivateTesterReleaseOperation(input: unknown): string {
  const value = JSON.stringify(stable(parseOperation(input, OPERATION_KEYS)));
  if (encoder.encode(value).byteLength > MAX_CANONICAL_BYTES) invalid();
  return value;
}
export function canonicalPrivateTesterDeploymentClaims(input: unknown): string {
  const value = JSON.stringify(stable(parseClaims(input)));
  if (encoder.encode(value).byteLength > MAX_CANONICAL_BYTES) invalid();
  return value;
}
export function privateTesterDeploymentManifestSignedBytes(input: unknown): string {
  return `${PRIVATE_TESTER_DEPLOYMENT_MANIFEST_DOMAIN}\n${canonicalPrivateTesterDeploymentClaims(input)}`;
}

export function composePrivateTesterDeploymentManifest(observedReleaseOperation: unknown, clock: () => number, nonceSource: () => string): PrivateTesterDeploymentClaims {
  if (typeof clock !== "function" || typeof nonceSource !== "function") invalid();
  const operation = parseOperation(observedReleaseOperation, OPERATION_KEYS), issuedAt = clock(), nonce = nonceSource();
  if (!integer(issuedAt) || typeof nonce !== "string") invalid();
  return parsePrivateTesterDeploymentManifest({ ...operation, notBefore: issuedAt, issuedAt, expiresAt: issuedAt + MAX_LIFETIME_MS, nonce }, issuedAt);
}

function hex(value: ArrayBuffer): string { return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function exactBuffer(value: Uint8Array): ArrayBuffer { return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer; }
function decodeSignature(value: unknown): Uint8Array {
  try {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), (entry) => entry.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    if (canonical !== value) throw new Error();
    return bytes;
  } catch { throw new Error("private tester deployment signature malformed"); }
}
function validateKeyRecord(record: unknown, claims: PrivateTesterDeploymentClaims): asserts record is KeyRecord {
  if (!exactRecord(record, KEY_RECORD_KEYS)) throw new Error("private tester deployment key invalid");
  const key = record.key;
  if (!(key instanceof CryptoKey)) throw new Error("private tester deployment key invalid");
  const algorithm = key.algorithm as RsaHashedKeyAlgorithm;
  if (record.principal !== claims.principal || record.keyId !== claims.keyId || record.version !== claims.keyVersion || typeof record.fingerprint !== "string" || !HASH.test(record.fingerprint) || key.type !== "public" || key.extractable !== true || key.usages.length !== 1 || key.usages[0] !== "verify" || algorithm.name !== "RSA-PSS" || algorithm.hash.name !== "SHA-256" || algorithm.modulusLength !== 3072 || algorithm.publicExponent.length !== 3 || algorithm.publicExponent[0] !== 1 || algorithm.publicExponent[1] !== 0 || algorithm.publicExponent[2] !== 1) throw new Error("private tester deployment key invalid");
}
export async function verifyPrivateTesterDeploymentManifestSignature(envelope: unknown, nowMs: number, record: unknown): Promise<PrivateTesterDeploymentClaims> {
  if (!exactRecord(envelope, ENVELOPE_KEYS)) invalid();
  const claims = parsePrivateTesterDeploymentManifest(envelope.claims, nowMs), signed = privateTesterDeploymentManifestSignedBytes(claims);
  validateKeyRecord(record, claims);
  let fingerprint: string;
  try { fingerprint = hex(await crypto.subtle.digest("SHA-256", await crypto.subtle.exportKey("spki", record.key))); } catch { throw new Error("private tester deployment key invalid"); }
  if (fingerprint !== record.fingerprint) throw new Error("private tester deployment key invalid");
  const signature = decodeSignature(envelope.signature);
  if (signature.byteLength !== 384) throw new Error("private tester deployment signature malformed");
  let valid = false;
  try { valid = await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 32 }, record.key, exactBuffer(signature), encoder.encode(signed)); } catch { throw new Error("private tester deployment signature check failed"); }
  if (!valid) throw new Error("private tester deployment signature invalid");
  return claims;
}
function validateTrust(trust: unknown, nowMs: number): asserts trust is Trust[] {
  if (!Array.isArray(trust) || trust.length < 1 || trust.length > 100) invalid();
  const seen = new Set<string>();
  for (const value of trust) {
    if (!exactRecord(value, TRUST_KEYS) || typeof value.principal !== "string" || !CLAIM_ID.test(value.principal) || typeof value.keyId !== "string" || !CLAIM_ID.test(value.keyId) || !integer(value.version, 1) || typeof value.fingerprint !== "string" || !HASH.test(value.fingerprint) || !integer(value.validFrom) || !integer(value.validUntil) || value.validFrom >= value.validUntil || value.usage !== "release-evidence" || !["active", "retiring", "revoked"].includes(String(value.status))) invalid();
    const tuple = `${value.principal}\0${value.keyId}\0${value.version}`;
    if (seen.has(tuple)) invalid();
    if (value.status === "revoked") { if (!integer(value.revokedAt) || Number(value.revokedAt) < value.validFrom || Number(value.revokedAt) > Math.min(value.validUntil, nowMs)) invalid(); }
    else if (value.revokedAt !== null) invalid();
    seen.add(tuple);
  }
}
export async function verifyPrivateTesterDeploymentManifest(envelope: unknown, options: { now: number; trust: unknown; lookupKey(principal: string, keyId: string, version: number): Promise<KeyRecord>; nonceStore: { consumeDeploymentManifestNonce(input: PrivateTesterDeploymentNonce): Promise<boolean> } }): Promise<PrivateTesterDeploymentClaims> {
  if (!options || !integer(options.now) || typeof options.lookupKey !== "function" || !options.nonceStore || typeof options.nonceStore.consumeDeploymentManifestNonce !== "function") invalid();
  validateTrust(options.trust, options.now);
  if (!exactRecord(envelope, ENVELOPE_KEYS)) invalid();
  const claims = parsePrivateTesterDeploymentManifest(envelope.claims, options.now);
  const trusted = options.trust.find((value) => value.principal === claims.principal && value.keyId === claims.keyId && value.version === claims.keyVersion && value.status !== "revoked" && options.now >= value.validFrom && options.now < value.validUntil);
  if (!trusted) throw new Error("private tester deployment signer untrusted");
  let record: KeyRecord;
  try { record = await options.lookupKey(claims.principal, claims.keyId, claims.keyVersion); } catch { throw new Error("private tester deployment key lookup failed"); }
  const verified = await verifyPrivateTesterDeploymentManifestSignature(envelope, options.now, record);
  if (record.fingerprint !== trusted.fingerprint) throw new Error("private tester deployment key invalid");
  const canonicalClaims = canonicalPrivateTesterDeploymentClaims(verified), claimsDigest = hex(await crypto.subtle.digest("SHA-256", encoder.encode(privateTesterDeploymentManifestSignedBytes(verified))));
  let consumed = false;
  try { consumed = await options.nonceStore.consumeDeploymentManifestNonce(Object.freeze({ nonce: verified.nonce, claimsDigest, principal: verified.principal, keyId: verified.keyId, keyVersion: verified.keyVersion, releaseId: verified.releaseId, expiresAt: verified.expiresAt, canonicalClaims })); } catch { throw new Error("private tester deployment nonce store failed"); }
  if (!consumed) throw new Error("private tester deployment replay rejected");
  return verified;
}
