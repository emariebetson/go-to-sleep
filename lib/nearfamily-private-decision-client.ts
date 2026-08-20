import {
  canonicalDecisionBody,
  canonicalDecisionEnvelope,
  sha256Hex,
  signDecisionEnvelope,
  type DecisionSigningClaims,
} from "../services/readiness-decision/src/envelope";

const encoder = new TextEncoder();
const release = /^rel_[A-Za-z0-9_-]{8,100}$/;
const key = /^[a-f0-9]{64}$/;
const nonce = /^[A-Za-z0-9_-]{22,128}$/;

type DecisionResponse = { version: 1; allowed: false } | { version: 1; allowed: true; expiresAt: number };

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function validResponse(value: unknown, now: number): value is DecisionResponse {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.allowed !== "boolean") return false;
  const keys = Object.keys(record);
  if (!record.allowed) return keys.length === 2 && keys.includes("version") && keys.includes("allowed");
  return keys.length === 3 && keys.includes("version") && keys.includes("allowed") && keys.includes("expiresAt") && Number.isSafeInteger(record.expiresAt) && Number(record.expiresAt) > now;
}

export function createNearFamilyPrivateDecisionClient(input: Readonly<{
  endpoint: string;
  signingKey: string;
  keyVersion: number;
  releaseId: string;
  now?: () => number;
  nonce?: () => string;
  fetch?: typeof fetch;
}>) {
  return Object.freeze({
    authorize: async (householdId: string): Promise<boolean> => {
      try {
        const endpoint = new URL(input.endpoint);
        const now = (input.now ?? Date.now)();
        const issuedNonce = (input.nonce ?? randomNonce)();
        if (endpoint.protocol !== "https:" || endpoint.pathname !== "/v1/nearfamily/decision" || !key.test(input.signingKey) || !Number.isSafeInteger(input.keyVersion) || input.keyVersion < 1 || !release.test(input.releaseId) || typeof householdId !== "string" || !/^hh_[A-Za-z0-9_-]{8,100}$/.test(householdId) || !Number.isSafeInteger(now) || !nonce.test(issuedNonce)) return false;
        const householdHash = await sha256Hex(householdId);
        const bodySha256 = await sha256Hex(canonicalDecisionBody({ releaseId: input.releaseId, householdHash }));
        const claims: DecisionSigningClaims = { version: 1, releaseId: input.releaseId, householdHash, issuedAt: now, nonce: issuedNonce, bodySha256, keyVersion: input.keyVersion };
        const signature = await signDecisionEnvelope(claims, hexBytes(input.signingKey));
        const body = canonicalDecisionEnvelope({ ...claims, signature });
        if (encoder.encode(body).byteLength > 4096) return false;
        const response = await (input.fetch ?? fetch)(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(2_000) });
        if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return false;
        const text = await response.text();
        if (encoder.encode(text).byteLength > 1024) return false;
        const result: unknown = JSON.parse(text);
        return validResponse(result, now) && result.allowed;
      } catch {
        return false;
      }
    },
  });
}
