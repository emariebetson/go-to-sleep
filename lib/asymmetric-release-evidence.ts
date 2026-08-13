const encoder = new TextEncoder();
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_:/.@-]{3,200}$/;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_LIFETIME_MS = 10 * 60_000;
type Kind = "rls" | "media" | "restore" | "load" | "accessibility" | "security" | "canary";

type Results =
  | { negativeTests: number; crossTenantViolations: 0 }
  | { canaries: number; failed: 0 }
  | { restoredObjects: number; checksumMismatches: 0 }
  | { requests: number; errorRateBps: number; p95Ms: number; maxErrorRateBps: number; maxP95Ms: number }
  | { checks: number; violations: 0 }
  | { critical: 0; high: 0; scanArtifact: string; penTestArtifact: string }
  | { startedAt:number;endedAt:number;heartbeatCount:number;deadLetters:0;completedJobs:number;failedJobs:0;reconciliationArtifact:string;terminalCount:number;terminalDigest:string;pending:0;outboxDeadLetters:0 };
export type Gate = { kind: Kind; policyVersion: 1; releaseId: string; schema: string; artifact: string; verifiedAt: number; results: Results };
export type Claims = { version: 1; principal: string; keyId: string; keyVersion: number; releaseId: string; schema: string; backfill: string; highWater: number; fence: number; notBefore: number; issuedAt: number; expiresAt: number; nonce: string; productReadiness: ProductReadiness[]; gates: Record<Kind, Gate>; shadow: { kind: "shadow"; policyVersion: 1; releaseId: string; schema: string; artifact: string; startedAt: number; endedAt: number; sourceChecksum: string; targetChecksum: string; sampleCount: number; observedRows:number; mismatchCount: 0 } };
export type ProductReadiness={product:"nearstory"|"nearfamily"|"nearlegacy";environment:"production";region:string;releaseId:string;artifact:string;imageDigest:string;expiresAt:number;controllerMapping:{verified:true;artifact:string;verifiedAt:number};secretVersions:Record<string,string>;probes:Record<string,{identity:string;passed:true;verifiedAt:number}>;capacity:{queueDepth:number;maxQueueDepth:number;errorRateBps:number;maxErrorRateBps:number;soakStartedAt:number;soakEndedAt:number};mobilePlatforms:("ios"|"android")[]};
export type Trust = { principal: string; keyId: string; version: number; fingerprint: string; status: "active" | "retiring" | "revoked"; validFrom: number; validUntil: number; revokedAt: number | null; usage: "release-evidence" };
export type KeyRecord = { principal: string; keyId: string; version: number; fingerprint: string; key: CryptoKey };

function exact(value: unknown, names: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("evidence schema invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((entry) => !Object.hasOwn(entry, "value") || entry.get || entry.set)) throw new Error("evidence schema invalid");
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...names].sort())) throw new Error("evidence schema invalid");
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max; }
function validateResults(kind: Kind, value: unknown) {
  const v = value as Record<string, unknown>;
  if (kind === "rls") { exact(v, ["negativeTests", "crossTenantViolations"]); return integer(v.negativeTests, 1) && v.crossTenantViolations === 0; }
  if (kind === "media") { exact(v, ["canaries", "failed"]); return integer(v.canaries, 1) && v.failed === 0; }
  if (kind === "restore") { exact(v, ["restoredObjects", "checksumMismatches"]); return integer(v.restoredObjects, 1) && v.checksumMismatches === 0; }
  if (kind === "load") { exact(v, ["requests", "errorRateBps", "p95Ms", "maxErrorRateBps", "maxP95Ms"]); return integer(v.requests, 1) && integer(v.errorRateBps, 0, 10_000) && integer(v.maxErrorRateBps, 0, 10_000) && Number(v.errorRateBps) <= Number(v.maxErrorRateBps) && integer(v.p95Ms, 1, 600_000) && integer(v.maxP95Ms, 1, 600_000) && Number(v.p95Ms) <= Number(v.maxP95Ms); }
  if (kind === "accessibility") { exact(v, ["checks", "violations"]); return integer(v.checks, 1) && v.violations === 0; }
  if(kind==="security"){exact(v, ["critical", "high", "scanArtifact", "penTestArtifact"]); return v.critical === 0 && v.high === 0 && typeof v.scanArtifact === "string" && HASH.test(v.scanArtifact) && typeof v.penTestArtifact === "string" && HASH.test(v.penTestArtifact);}
  exact(v,["startedAt","endedAt","heartbeatCount","deadLetters","completedJobs","failedJobs","reconciliationArtifact","terminalCount","terminalDigest","pending","outboxDeadLetters"]);return integer(v.startedAt)&&integer(v.endedAt)&&Number(v.endedAt)-Number(v.startedAt)>=86_400_000&&integer(v.heartbeatCount,1368,2000)&&v.deadLetters===0&&integer(v.completedJobs,1)&&v.failedJobs===0&&typeof v.reconciliationArtifact==="string"&&HASH.test(v.reconciliationArtifact)&&integer(v.terminalCount,1)&&typeof v.terminalDigest==="string"&&HASH.test(v.terminalDigest)&&v.pending===0&&v.outboxDeadLetters===0;
}
export function validateProductReadinessExact(item:ProductReadiness,context:{releaseId:string;notBefore:number;issuedAt:number;expiresAt:number}){exact(item,["product","environment","region","releaseId","artifact","imageDigest","expiresAt","controllerMapping","secretVersions","probes","capacity","mobilePlatforms"]);exact(item.controllerMapping,["verified","artifact","verifiedAt"]);if(item.controllerMapping.verified!==true||!HASH.test(item.controllerMapping.artifact)||!integer(item.controllerMapping.verifiedAt)||item.controllerMapping.verifiedAt<context.notBefore||item.controllerMapping.verifiedAt>context.issuedAt)throw new Error("product readiness invalid");if(!["nearstory","nearfamily","nearlegacy"].includes(item.product)||item.environment!=="production"||item.releaseId!==context.releaseId||!HASH.test(item.artifact)||!HASH.test(item.imageDigest)||!integer(item.expiresAt)||item.expiresAt>context.expiresAt||!ID.test(item.region))throw new Error("product readiness invalid");exact(item.secretVersions,Object.keys(item.secretVersions));if(Object.keys(item.secretVersions).length<1||Object.values(item.secretVersions).some(v=>!/^projects\/[a-z0-9-]+\/secrets\/[A-Za-z0-9_-]+\/versions\/[1-9][0-9]*$/.test(v)))throw new Error("product readiness invalid");exact(item.probes,Object.keys(item.probes));const required=item.product==="nearfamily"?["identity","member","entitlement","invite","privacy"]:["worker","scheduler","processor"];if(required.some(k=>!item.probes[k]))throw new Error("product readiness invalid");for(const probe of Object.values(item.probes)){exact(probe,["identity","passed","verifiedAt"]);if(!ID.test(probe.identity)||probe.passed!==true||!integer(probe.verifiedAt)||probe.verifiedAt<context.notBefore||probe.verifiedAt>context.issuedAt)throw new Error("product readiness invalid")}exact(item.capacity,["queueDepth","maxQueueDepth","errorRateBps","maxErrorRateBps","soakStartedAt","soakEndedAt"]);if(!integer(item.capacity.queueDepth)||!integer(item.capacity.maxQueueDepth,1)||item.capacity.queueDepth>item.capacity.maxQueueDepth||!integer(item.capacity.errorRateBps,0,10000)||!integer(item.capacity.maxErrorRateBps,0,10000)||item.capacity.errorRateBps>item.capacity.maxErrorRateBps||!integer(item.capacity.soakStartedAt)||!integer(item.capacity.soakEndedAt)||item.capacity.soakEndedAt-item.capacity.soakStartedAt<3600000||item.capacity.soakEndedAt>context.issuedAt)throw new Error("product readiness invalid");if(item.product==="nearfamily"&&JSON.stringify([...item.mobilePlatforms].sort())!==JSON.stringify(["android","ios"]))throw new Error("product readiness invalid");return true}
function validateClaims(claims: Claims) {
  exact(claims, ["version", "principal", "keyId", "keyVersion", "releaseId", "schema", "backfill", "highWater", "fence", "notBefore", "issuedAt", "expiresAt", "nonce", "productReadiness", "gates", "shadow"]);
  if (claims.version !== 1 || ![claims.principal, claims.keyId, claims.releaseId].every((v) => typeof v === "string" && ID.test(v)) || !integer(claims.keyVersion, 1) || !HASH.test(claims.schema) || !HASH.test(claims.backfill) || !integer(claims.highWater) || !integer(claims.fence, 1) || !integer(claims.notBefore) || !integer(claims.issuedAt) || !integer(claims.expiresAt) || !NONCE.test(claims.nonce)) throw new Error("evidence claims invalid");
  if (!Array.isArray(claims.productReadiness) || claims.productReadiness.length !== 3) throw new Error("product readiness invalid");
  const products = new Set<string>();
  for(const item of claims.productReadiness){if(products.has(item.product))throw new Error("product readiness invalid");validateProductReadinessExact(item,claims);products.add(item.product)}
  exact(claims.gates, ["rls", "media", "restore", "load", "accessibility", "security", "canary"]);
  for (const kind of Object.keys(claims.gates) as Kind[]) {
    const gate = claims.gates[kind]; exact(gate, ["kind", "policyVersion", "releaseId", "schema", "artifact", "verifiedAt", "results"]);
    if (gate.kind !== kind || gate.policyVersion !== 1 || gate.releaseId !== claims.releaseId || gate.schema !== claims.schema || !HASH.test(gate.artifact) || !integer(gate.verifiedAt) || gate.verifiedAt < claims.notBefore || gate.verifiedAt > claims.issuedAt || !validateResults(kind, gate.results)) throw new Error("evidence gate invalid");
  }
  const shadow = claims.shadow; exact(shadow, ["kind", "policyVersion", "releaseId", "schema", "artifact", "startedAt", "endedAt", "sourceChecksum", "targetChecksum", "sampleCount", "observedRows", "mismatchCount"]);
  if (shadow.kind !== "shadow" || shadow.policyVersion !== 1 || shadow.releaseId !== claims.releaseId || shadow.schema !== claims.schema || !HASH.test(shadow.artifact) || shadow.sourceChecksum !== claims.backfill || shadow.targetChecksum !== claims.backfill || !integer(shadow.startedAt) || !integer(shadow.endedAt) || shadow.startedAt < claims.notBefore || shadow.endedAt > claims.issuedAt || shadow.endedAt - shadow.startedAt < 60_000 || !integer(shadow.sampleCount, 3) || !integer(shadow.observedRows) || shadow.mismatchCount !== 0) throw new Error("evidence shadow invalid");
}
function stable(value: unknown, state = { nodes: 0, seen: new WeakSet<object>() }, depth = 0): unknown {
  if (++state.nodes > 20_000 || depth > 40) throw new Error("evidence payload complex");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value))) return value;
  if(Array.isArray(value)){if(state.seen.has(value)||value.length>100)throw new Error("evidence payload invalid");state.seen.add(value);const out=value.map(child=>stable(child,state,depth+1));state.seen.delete(value);return out}
  if (!value || typeof value !== "object" || state.seen.has(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("evidence payload invalid");
  state.seen.add(value); const out = Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child, state, depth + 1)])); state.seen.delete(value); return out;
}
export function canonicalEvidence(claims: Claims) { validateClaims(claims); const result = JSON.stringify(stable(claims)); if (encoder.encode(result).byteLength > MAX_PAYLOAD_BYTES) throw new Error("evidence payload oversized"); return result; }
function hex(bytes: ArrayBuffer) { return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, "0")).join(""); }
function decodeSignature(value: string) { try { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(); const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4); const bytes = Uint8Array.from(atob(padded), (v) => v.charCodeAt(0)); const canonical = btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); if (canonical !== value) throw new Error(); return bytes; } catch { throw new Error("evidence signature malformed"); } }
function validateTrust(records: Trust[], now: number) {
  const seen = new Set<string>();
  for (const record of records) {
    exact(record, ["principal", "keyId", "version", "fingerprint", "status", "validFrom", "validUntil", "revokedAt", "usage"]);
    const tuple = `${record.principal}\0${record.keyId}\0${record.version}`;
    if (seen.has(tuple) || !ID.test(record.principal) || !ID.test(record.keyId) || !integer(record.version, 1) || !HASH.test(record.fingerprint) || !integer(record.validFrom) || !integer(record.validUntil) || record.validFrom >= record.validUntil || record.usage !== "release-evidence" || !["active", "retiring", "revoked"].includes(record.status)) throw new Error("trust configuration invalid");
    if (record.status === "revoked") { if (!integer(record.revokedAt) || Number(record.revokedAt) < record.validFrom || Number(record.revokedAt) > Math.min(record.validUntil, now)) throw new Error("trust configuration invalid"); } else if (record.revokedAt !== null) throw new Error("trust configuration invalid");
    seen.add(tuple);
  }
}
export async function verifyReleaseEvidence(envelope: { claims: Claims; signature: string }, options: { now: number; trust: Trust[]; lookupKey(principal: string, keyId: string, version: number): Promise<KeyRecord>; consumeNonce(input: { nonce: string; claimsDigest: string; principal: string; keyId: string; keyVersion: number; releaseId: string; expiresAt: number; canonicalClaims: string }): Promise<boolean> }) {
  const body = canonicalEvidence(envelope.claims); const claims = envelope.claims;
  if (!integer(options.now)) throw new Error("evidence freshness invalid"); validateTrust(options.trust, options.now);
  if (claims.notBefore > claims.issuedAt || claims.notBefore > options.now + 30_000 || claims.issuedAt > options.now + 30_000 || claims.issuedAt > claims.expiresAt || claims.expiresAt - claims.issuedAt > MAX_LIFETIME_MS || options.now - claims.issuedAt > 300_000 || claims.expiresAt <= options.now) throw new Error("evidence freshness invalid");
  const trust = options.trust.find((entry) => entry.principal === claims.principal && entry.keyId === claims.keyId && entry.version === claims.keyVersion && entry.status !== "revoked" && options.now >= entry.validFrom && options.now < entry.validUntil);
  if (!trust) throw new Error("evidence signer untrusted");
  let record: KeyRecord; try { record = await options.lookupKey(claims.principal, claims.keyId, claims.keyVersion); } catch { throw new Error("evidence key lookup failed"); }
  exact(record, ["principal", "keyId", "version", "fingerprint", "key"]); const algorithm = record.key.algorithm as RsaHashedKeyAlgorithm;
  if (record.principal !== claims.principal || record.keyId !== claims.keyId || record.version !== claims.keyVersion || record.key.type !== "public" || record.key.usages.length !== 1 || record.key.usages[0] !== "verify" || algorithm.name !== "RSA-PSS" || algorithm.hash.name !== "SHA-256" || algorithm.modulusLength < 3072 || algorithm.publicExponent.length !== 3 || algorithm.publicExponent[0] !== 1 || algorithm.publicExponent[1] !== 0 || algorithm.publicExponent[2] !== 1) throw new Error("evidence key invalid");
  let fingerprint: string; try { fingerprint = hex(await crypto.subtle.digest("SHA-256", await crypto.subtle.exportKey("spki", record.key))); } catch { throw new Error("evidence key invalid"); }
  if (fingerprint !== trust.fingerprint || record.fingerprint !== fingerprint) throw new Error("evidence key invalid"); const signature = decodeSignature(envelope.signature); if (signature.byteLength !== algorithm.modulusLength / 8) throw new Error("evidence signature malformed");
  let valid = false; try { valid = await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 32 }, record.key, signature, encoder.encode(body)); } catch { throw new Error("evidence signature check failed"); } if (!valid) throw new Error("evidence signature invalid");
  const claimsDigest = hex(await crypto.subtle.digest("SHA-256", encoder.encode(body))); let consumed = false; try { consumed = await options.consumeNonce(Object.freeze({ nonce: claims.nonce, claimsDigest, principal: claims.principal, keyId: claims.keyId, keyVersion: claims.keyVersion, releaseId: claims.releaseId, expiresAt: claims.expiresAt, canonicalClaims: body })); } catch { throw new Error("evidence nonce store failed"); } if (!consumed) throw new Error("evidence replay rejected"); return true;
}
