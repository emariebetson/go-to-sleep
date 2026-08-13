import { env } from "cloudflare:workers";
import { createServiceOidcAuthenticator } from "@/lib/service-oidc";

const jobIdentifier = /^(?:[A-Za-z0-9_-]{8,200}|job:[a-f0-9]{64})$/;
export async function POST(request: Request) {
  const runtime = env as unknown as { EVIDENCE_COLLECTION_APPROVED?: string; READINESS_PG: { transaction<T>(run: (tx: { query<T>(sql: string, args: unknown[]): Promise<{ rows: T[] }> }) => Promise<T>): Promise<T> }; READINESS_OIDC_ISSUER: string; READINESS_OIDC_AUDIENCE: string; READINESS_OIDC_SUBJECT: string; READINESS_OIDC_JWKS_URL: string };
  if (runtime.EVIDENCE_COLLECTION_APPROVED !== "true") return new Response("Not found", { status: 404 });
  const identity = await createServiceOidcAuthenticator({ issuer: runtime.READINESS_OIDC_ISSUER, audience: runtime.READINESS_OIDC_AUDIENCE, subject: runtime.READINESS_OIDC_SUBJECT, jwksUrl: runtime.READINESS_OIDC_JWKS_URL, clock: { now: async () => Date.now() } })(request);
  const body = await request.json() as Record<string, unknown>, operation = String(body.operation);
  if (!/^rel_[A-Za-z0-9_-]{8,100}$/.test(String(body.releaseId)) || !Number.isSafeInteger(body.releaseVersion) || !new Set(["nearstory", "nearlegacy"]).has(String(body.product)) || typeof body.jobId !== "string" || !jobIdentifier.test(body.jobId) || ![body.householdId, body.attemptToken].every(value => typeof value === "string" && /^[A-Za-z0-9_-]{8,200}$/.test(value)) || !new Set(["attempt_started", "terminal"]).has(operation) || ![body.inputChecksum, body.evidenceChecksum].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) || operation === "terminal" && !new Set(["succeeded", "failed", "dead_letter"]).has(String(body.status))) return new Response("Invalid", { status: 400 });
  const inserted = await runtime.READINESS_PG.transaction(async transaction => {
    await transaction.query("SELECT set_config('nearyou.service_principal',$1,true)", [identity.principal]);
    return (await transaction.query<{ inserted: boolean }>("SELECT nearyou.record_operational_worker_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) inserted", [body.releaseId, body.releaseVersion, body.product, body.jobId, body.householdId, body.attemptToken, body.inputChecksum, body.evidenceChecksum, operation, body.status ?? null])).rows[0]?.inserted === true;
  });
  return Response.json({ inserted }, { headers: { "cache-control": "no-store" } });
}
