import { env } from "cloudflare:workers";
import { createServiceOidcAuthenticator } from "@/lib/service-oidc";

export async function POST(request: Request) {
  const runtime = env as unknown as { EVIDENCE_COLLECTION_APPROVED?: string; READINESS_PG: { transaction<T>(run: (tx: { query<T>(sql: string, args: unknown[]): Promise<{ rows: T[] }> }) => Promise<T>): Promise<T> }; READINESS_OIDC_ISSUER: string; READINESS_OIDC_AUDIENCE: string; READINESS_OIDC_SUBJECT: string; READINESS_OIDC_JWKS_URL: string; RELEASE_ID: string };
  if (runtime.EVIDENCE_COLLECTION_APPROVED !== "true") return new Response("Not found", { status: 404 });
  const identity = await createServiceOidcAuthenticator({ issuer: runtime.READINESS_OIDC_ISSUER, audience: runtime.READINESS_OIDC_AUDIENCE, subject: runtime.READINESS_OIDC_SUBJECT, jwksUrl: runtime.READINESS_OIDC_JWKS_URL, clock: { now: async () => Date.now() } })(request);
  const inserted = await runtime.READINESS_PG.transaction(async transaction => {
    await transaction.query("SELECT set_config('nearyou.service_principal',$1,true)", [identity.principal]);
    return (await transaction.query<{ inserted: boolean }>("SELECT nearyou.record_canary_evidence_sample($1) inserted", [runtime.RELEASE_ID])).rows[0]?.inserted === true;
  });
  return Response.json({ inserted }, { headers: { "cache-control": "no-store" } });
}
