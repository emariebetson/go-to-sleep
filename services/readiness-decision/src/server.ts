import { verifyAndConsumeDecisionEnvelope, type DecisionKey, type DecisionNonceStore } from "./envelope";

type DecisionInput = Readonly<{ householdHash: string; releaseId: string; observedAt: number }>;
type DecisionResult = Readonly<{ allowed: boolean; expiresAt?: number }>;
export type DecisionAuthority = { authorize(input: DecisionInput): Promise<DecisionResult> };
type Pg = { query<T>(sql: string, args: unknown[]): Promise<{ rows: T[] }> };

const encoder = new TextEncoder();

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function validResult(value: DecisionResult, now: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || typeof value.allowed !== "boolean") return false;
  const keys = Object.keys(value);
  if (value.allowed) return keys.length === 2 && keys.includes("expiresAt") && Number.isSafeInteger(value.expiresAt) && Number(value.expiresAt) > now;
  return keys.length === 1 || (keys.length === 2 && keys.includes("expiresAt") && Number.isSafeInteger(value.expiresAt));
}

export function createPostgresDecisionAuthority(pg: Pg): DecisionAuthority {
  if (!pg || typeof pg.query !== "function") throw new Error("decision authority unavailable");
  return Object.freeze({
    authorize: async (input: DecisionInput): Promise<DecisionResult> => {
      const result = await pg.query<{ allowed: boolean; expires_at: Date | string | null }>("SELECT allowed, expires_at FROM nearyou.authorize_nearfamily_private_tester($1,$2,$3)", [input.householdHash, input.releaseId, new Date(input.observedAt)]);
      if (result.rows.length !== 1 || typeof result.rows[0]?.allowed !== "boolean") throw new Error("decision authority unavailable");
      const row = result.rows[0];
      if (!row.allowed) return Object.freeze({ allowed: false });
      const expiresAt = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(String(row.expires_at));
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= input.observedAt) throw new Error("decision authority unavailable");
      return Object.freeze({ allowed: true, expiresAt });
    },
  });
}

export function createReadinessDecisionServer(input: Readonly<{
  issuer: string;
  now(): Promise<number>;
  keys: readonly DecisionKey[];
  nonceStore: DecisionNonceStore;
  authority: DecisionAuthority;
}>) {
  if (!input || typeof input !== "object" || typeof input.now !== "function" || !input.authority || typeof input.authority.authorize !== "function") throw new Error("decision server invalid");
  return Object.freeze({
    handle: async (request: Request): Promise<Response> => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/nearfamily/decision") return response(404, { version: 1, allowed: false });
      if (request.headers.get("content-type") !== "application/json") return response(415, { version: 1, allowed: false });
      const length = Number(request.headers.get("content-length"));
      if (Number.isFinite(length) && length > 4096) return response(413, { version: 1, allowed: false });
      let raw: string;
      try { raw = await request.text(); } catch { return response(401, { version: 1, allowed: false }); }
      if (encoder.encode(raw).byteLength > 4096) return response(413, { version: 1, allowed: false });
      let observedAt: number;
      try { observedAt = await input.now(); } catch { return response(503, { version: 1, allowed: false }); }
      let envelope;
      try { envelope = await verifyAndConsumeDecisionEnvelope(raw, { issuer: input.issuer, now: observedAt, keys: input.keys, nonceStore: input.nonceStore }); } catch { return response(401, { version: 1, allowed: false }); }
      try {
        const result = await input.authority.authorize({ householdHash: envelope.householdHash, releaseId: envelope.releaseId, observedAt });
        if (!validResult(result, observedAt)) throw new Error("decision result invalid");
        return result.allowed ? response(200, { version: 1, allowed: true, expiresAt: result.expiresAt }) : response(200, { version: 1, allowed: false });
      } catch { return response(503, { version: 1, allowed: false }); }
    },
  });
}
