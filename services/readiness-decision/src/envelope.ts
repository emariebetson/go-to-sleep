const encoder = new TextEncoder();
const HASH = /^[a-f0-9]{64}$/;
const RELEASE = /^rel_[A-Za-z0-9_-]{8,100}$/;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

export type DecisionSigningClaims = {
  version: 1;
  releaseId: string;
  householdHash: string;
  issuedAt: number;
  nonce: string;
  bodySha256: string;
  keyVersion: number;
};

export type DecisionEnvelope = DecisionSigningClaims & { signature: string };
export type DecisionKey = {
  version: number;
  status: "current" | "draining";
  rollbackCompatible?: boolean;
  notBefore: number;
  notAfter: number;
  key: Uint8Array;
};
export type DecisionNonceStore = {
  consume(input: Readonly<{
    issuer: string;
    keyVersion: number;
    nonce: string;
    requestSha256: string;
    expiresAt: number;
  }>): Promise<boolean>;
};

const SIGNING_KEYS = ["version", "releaseId", "householdHash", "issuedAt", "nonce", "bodySha256", "keyVersion"] as const;
const ENVELOPE_KEYS = [...SIGNING_KEYS, "signature"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === names.length && Object.keys(value).every((name) => names.includes(name));
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, child]) => [name, stable(child)]));
}

function validateSigningClaims(value: unknown): asserts value is DecisionSigningClaims {
  if (!exact(value, SIGNING_KEYS) || value.version !== 1 || typeof value.releaseId !== "string" || !RELEASE.test(value.releaseId) || typeof value.householdHash !== "string" || !HASH.test(value.householdHash) || !safeInteger(value.issuedAt) || typeof value.nonce !== "string" || !NONCE.test(value.nonce) || typeof value.bodySha256 !== "string" || !HASH.test(value.bodySha256) || !safeInteger(value.keyVersion, 1)) throw new Error("decision envelope invalid");
}

function validateEnvelope(value: unknown): asserts value is DecisionEnvelope {
  if (!exact(value, ENVELOPE_KEYS)) throw new Error("decision envelope invalid");
  const claims = { version: value.version, releaseId: value.releaseId, householdHash: value.householdHash, issuedAt: value.issuedAt, nonce: value.nonce, bodySha256: value.bodySha256, keyVersion: value.keyVersion };
  validateSigningClaims(claims);
  if (typeof value.signature !== "string" || !SIGNATURE.test(value.signature)) throw new Error("decision envelope invalid");
}

export function canonicalDecisionBody(value: { releaseId: string; householdHash: string }): string {
  if (!exact(value, ["releaseId", "householdHash"]) || typeof value.releaseId !== "string" || !RELEASE.test(value.releaseId) || typeof value.householdHash !== "string" || !HASH.test(value.householdHash)) throw new Error("decision body invalid");
  return JSON.stringify(stable(value));
}

export function canonicalDecisionSigningClaims(value: DecisionSigningClaims | DecisionEnvelope): string {
  if (record(value) && "signature" in value) {
    validateEnvelope(value);
    const claims = { version: value.version, releaseId: value.releaseId, householdHash: value.householdHash, issuedAt: value.issuedAt, nonce: value.nonce, bodySha256: value.bodySha256, keyVersion: value.keyVersion };
    return JSON.stringify(stable(claims));
  }
  validateSigningClaims(value);
  return JSON.stringify(stable(value));
}

export function canonicalDecisionEnvelope(value: DecisionEnvelope): string {
  validateEnvelope(value);
  return JSON.stringify(stable(value));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!SIGNATURE.test(value)) throw new Error("decision signature invalid");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32 || base64Url(bytes) !== value) throw new Error("decision signature invalid");
  return bytes;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function importHmac(key: Uint8Array): Promise<CryptoKey> {
  if (!(key instanceof Uint8Array) || key.byteLength < 32 || key.byteLength > 128) throw new Error("decision key invalid");
  return crypto.subtle.importKey("raw", buffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sha256Hex(value: string): Promise<string> {
  if (typeof value !== "string") throw new Error("digest input invalid");
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signDecisionEnvelope(claims: DecisionSigningClaims, key: Uint8Array): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await importHmac(key), encoder.encode(canonicalDecisionSigningClaims(claims)));
  return base64Url(new Uint8Array(signature));
}

function validateKeys(keys: readonly DecisionKey[]): void {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2) throw new Error("decision trust invalid");
  const versions = new Set<number>();
  let current = 0;
  for (const key of keys) {
    if (!exact(key, key.status === "draining" ? ["version", "status", "rollbackCompatible", "notBefore", "notAfter", "key"] : ["version", "status", "notBefore", "notAfter", "key"]) || !safeInteger(key.version, 1) || versions.has(key.version) || !(key.status === "current" || key.status === "draining") || !safeInteger(key.notBefore) || !safeInteger(key.notAfter) || key.notBefore >= key.notAfter || !(key.key instanceof Uint8Array) || key.key.byteLength < 32 || key.key.byteLength > 128) throw new Error("decision trust invalid");
    if (key.status === "current") current += 1;
    if (key.status === "draining" && key.rollbackCompatible !== true) throw new Error("decision trust invalid");
    versions.add(key.version);
  }
  if (current !== 1) throw new Error("decision trust invalid");
}

export async function verifyAndConsumeDecisionEnvelope(raw: string, options: Readonly<{
  issuer: string;
  now: number;
  keys: readonly DecisionKey[];
  nonceStore: DecisionNonceStore;
}>): Promise<DecisionEnvelope> {
  if (typeof raw !== "string" || encoder.encode(raw).byteLength < 2 || encoder.encode(raw).byteLength > 4096 || typeof options.issuer !== "string" || options.issuer.length < 3 || options.issuer.length > 200 || !safeInteger(options.now) || !options.nonceStore || typeof options.nonceStore.consume !== "function") throw new Error("decision envelope invalid");
  validateKeys(options.keys);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("decision envelope invalid"); }
  validateEnvelope(value);
  if (canonicalDecisionEnvelope(value) !== raw) throw new Error("decision envelope invalid");
  if (value.issuedAt < options.now - 300_000 || value.issuedAt > options.now + 60_000) throw new Error("decision envelope stale");
  const expectedBody = await sha256Hex(canonicalDecisionBody({ releaseId: value.releaseId, householdHash: value.householdHash }));
  if (expectedBody !== value.bodySha256) throw new Error("decision body invalid");
  const trusted = options.keys.find((candidate) => candidate.version === value.keyVersion && options.now >= candidate.notBefore && options.now < candidate.notAfter && value.issuedAt >= candidate.notBefore && value.issuedAt < candidate.notAfter && (candidate.status === "current" || candidate.rollbackCompatible === true));
  if (!trusted) throw new Error("decision key untrusted");
  let verified = false;
  try { verified = await crypto.subtle.verify("HMAC", await importHmac(trusted.key), buffer(decodeBase64Url(value.signature)), encoder.encode(canonicalDecisionSigningClaims(value))); } catch { throw new Error("decision signature invalid"); }
  if (!verified) throw new Error("decision signature invalid");
  const requestSha256 = await sha256Hex(raw);
  let consumed = false;
  try { consumed = await options.nonceStore.consume(Object.freeze({ issuer: options.issuer, keyVersion: value.keyVersion, nonce: value.nonce, requestSha256, expiresAt: options.now + 600_000 })); } catch { throw new Error("decision nonce uncertain"); }
  if (!consumed) throw new Error("decision nonce replay");
  return Object.freeze({ ...value });
}
