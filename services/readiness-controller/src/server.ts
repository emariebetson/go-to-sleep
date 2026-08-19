import { validatePrivateTesterActivationRequest, type PrivateTesterActivationResult } from "../../../lib/private-tester-activation";

type ControllerRequest = {
  action: "activate" | "revoke" | "kill";
  operationId: string;
  product: "nearstory" | "nearfamily";
  expectedVersion: number;
  promotedBaselineSha256: string;
  releaseEvidenceDigest: string;
  releaseId: string;
  invites: { householdHash: string; expiresAt: number }[];
};
type IdentityConfig = Readonly<{ issuer: string; audience: string; subject: string }>;
type VerifiedIdentity = Readonly<{ issuer: string; audience: string; subject: string; expiresAt: number }>;
type TokenVerifier = (input: Readonly<{ token: string; audience: string }>) => Promise<VerifiedIdentity>;
type ControllerExecutor = { apply(request: ControllerRequest, context: Readonly<{ principal: string; requestSha256: string; canonicalRequest: string }>): Promise<PrivateTesterActivationResult> };

const encoder = new TextEncoder();
const HASH = /^[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, child]) => [name, stable(child)]));
}

function canonicalRequest(value: unknown): string {
  validatePrivateTesterActivationRequest(value);
  return JSON.stringify(stable(value));
}

async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function validIdentity(value: unknown, expected: IdentityConfig, now: number): value is VerifiedIdentity {
  if (!record(value) || Object.keys(value).length !== 4 || !Object.keys(value).every((key) => ["issuer", "audience", "subject", "expiresAt"].includes(key))) return false;
  return value.issuer === expected.issuer && value.audience === expected.audience && value.subject === expected.subject && Number.isSafeInteger(value.expiresAt) && Number(value.expiresAt) > now && Number(value.expiresAt) <= now + 3_600_000;
}

function validIdentityConfig(value: IdentityConfig): boolean {
  return record(value) && Object.keys(value).length === 3 && typeof value.issuer === "string" && value.issuer === "https://accounts.google.com" && typeof value.audience === "string" && /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_./-]*)?$/.test(value.audience) && typeof value.subject === "string" && /^[a-z0-9-]{3,100}@[a-z0-9-]{3,100}\.iam\.gserviceaccount\.com$/.test(value.subject);
}

function validResult(value: unknown, request: ControllerRequest): value is PrivateTesterActivationResult {
  if (!record(value) || Object.keys(value).length !== 6 || !Object.keys(value).every((key) => ["product", "releaseId", "version", "globalPercent", "status", "auditDigest"].includes(key))) return false;
  const status = request.action === "activate" ? "active" : request.action === "revoke" ? "revoked" : "killed";
  return value.product === "nearfamily" && (typeof value.releaseId === "string" || value.releaseId === null) && Number.isSafeInteger(value.version) && Number(value.version) > request.expectedVersion && value.globalPercent === 0 && value.status === status && typeof value.auditDigest === "string" && HASH.test(value.auditDigest);
}

function bearer(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [A-Za-z0-9._~-]{8,8192}$/.test(authorization)) return null;
  return authorization.slice(7);
}

export function createReadinessControllerServer(input: Readonly<{
  now(): Promise<number>;
  ordinaryIdentity: IdentityConfig;
  emergencyIdentity: IdentityConfig;
  verifyIdToken: TokenVerifier;
  ordinaryController: ControllerExecutor;
  emergencyController: ControllerExecutor;
}>) {
  if (!input || typeof input !== "object" || typeof input.now !== "function" || typeof input.verifyIdToken !== "function" || !validIdentityConfig(input.ordinaryIdentity) || !validIdentityConfig(input.emergencyIdentity) || input.ordinaryIdentity.audience === input.emergencyIdentity.audience || input.ordinaryIdentity.subject === input.emergencyIdentity.subject || !input.ordinaryController || typeof input.ordinaryController.apply !== "function" || !input.emergencyController || typeof input.emergencyController.apply !== "function") throw new Error("controller server invalid");
  return Object.freeze({
    handle: async (request: Request): Promise<Response> => {
      const path = new URL(request.url).pathname;
      const emergency = path === "/v1/nearfamily/emergency";
      if (request.method !== "POST" || (!emergency && path !== "/v1/nearfamily/controller")) return json(404, { version: 1, accepted: false });
      if (request.headers.get("content-type") !== "application/json") return json(415, { version: 1, accepted: false });
      const token = bearer(request);
      if (!token) return json(403, { version: 1, accepted: false });
      let now: number;
      try { now = await input.now(); } catch { return json(503, { version: 1, accepted: false }); }
      if (!Number.isSafeInteger(now)) return json(503, { version: 1, accepted: false });
      const expectedIdentity = emergency ? input.emergencyIdentity : input.ordinaryIdentity;
      let identity: VerifiedIdentity;
      try { identity = await input.verifyIdToken({ token, audience: expectedIdentity.audience }); } catch { return json(403, { version: 1, accepted: false }); }
      if (!validIdentity(identity, expectedIdentity, now)) return json(403, { version: 1, accepted: false });
      let raw: string;
      try { raw = await request.text(); } catch { return json(400, { version: 1, accepted: false }); }
      if (encoder.encode(raw).byteLength < 2 || encoder.encode(raw).byteLength > 128_000) return json(413, { version: 1, accepted: false });
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return json(400, { version: 1, accepted: false }); }
      let canonical: string;
      try { canonical = canonicalRequest(parsed); } catch { return json(400, { version: 1, accepted: false }); }
      const body = parsed as ControllerRequest;
      if (canonical !== raw || body.product !== "nearfamily" || body.expectedVersion < 1 || (emergency ? !(body.action === "kill" || body.action === "revoke") : !(body.action === "activate" || body.action === "revoke"))) return json(400, { version: 1, accepted: false });
      const requestSha256 = await sha256(raw);
      if (request.headers.get("x-nearyou-request-sha256") !== requestSha256) return json(401, { version: 1, accepted: false });
      const executor = emergency ? input.emergencyController : input.ordinaryController;
      try {
        const result = await executor.apply(body, Object.freeze({ principal: identity.subject, requestSha256, canonicalRequest: canonical }));
        if (!validResult(result, body)) throw new Error("controller result invalid");
        return json(200, { ...result });
      } catch (error) {
        return json(error instanceof Error && /replay conflict/.test(error.message) ? 409 : 503, { version: 1, accepted: false });
      }
    },
  });
}
