import { env } from "cloudflare:workers";
import { createServiceOidcAuthenticator } from "@/lib/service-oidc";
import { SITES_D1_FORWARD_ARTIFACT } from "@/lib/sites-d1-forward-artifact.generated";
import { SitesD1ForwardOperation, type SitesD1ForwardInput } from "@/lib/sites-d1-forward-operation";

const ROUTE_ENABLED = true as const;
type Runtime = { DB: D1Database; READINESS_OIDC_ISSUER: string; READINESS_OIDC_AUDIENCE: string; READINESS_OIDC_SUBJECT: string; READINESS_OIDC_JWKS_URL: string; D1_FORWARD_BASELINE_SCHEMA_SHA256: string; D1_0026_AUTHORIZATION_SHA256?: string };
const HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9:_-]{8,128}$/;
const digest = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))].map(v => v.toString(16).padStart(2, "0")).join("");

export async function POST(request: Request) {
  if (!ROUTE_ENABLED) return new Response("Not found", { status: 404 });
  const runtime = env as unknown as Runtime;
  await createServiceOidcAuthenticator({ issuer: runtime.READINESS_OIDC_ISSUER, audience: runtime.READINESS_OIDC_AUDIENCE, subject: runtime.READINESS_OIDC_SUBJECT, jwksUrl: runtime.READINESS_OIDC_JWKS_URL, clock: { now: async () => Date.now() } })(request);
  const body = await request.json() as Partial<SitesD1ForwardInput>;
  const baseline = SITES_D1_FORWARD_ARTIFACT.schemaCheckpoints.find(value => value.head === "0016");
  if (!ID.test(body.operationId ?? "") || !ID.test(body.releaseId ?? "") || !Number.isSafeInteger(body.issuedAt) || !baseline || !HASH.test(runtime.D1_FORWARD_BASELINE_SCHEMA_SHA256) || baseline.definitionsSha256 !== runtime.D1_FORWARD_BASELINE_SCHEMA_SHA256) return new Response("Invalid", { status: 400 });
  const phase = body.phase;
  if (phase !== "0017-0025" && phase !== "0026") return new Response("Invalid", { status: 400 });
  const migrations = SITES_D1_FORWARD_ARTIFACT.migrations.filter(value => phase === "0026" ? value.id.startsWith("0026_") : Number(value.id.slice(0, 4)) >= 17 && Number(value.id.slice(0, 4)) <= 25).map(({ id, sha256, sql }) => ({ id, sha256, sql }));
  const authorization = phase === "0026" ? { purpose: "d1-0026-separate-authorization" as const, releaseId: body.releaseId!, operationId: body.operationId!, migrationSha256: migrations[0]!.sha256 } : undefined;
  if (phase === "0026" && runtime.D1_0026_AUTHORIZATION_SHA256 !== await digest(authorization)) return new Response("Not found", { status: 404 });
  try {
    const result = await new SitesD1ForwardOperation(runtime.DB).run({ operationId: body.operationId!, releaseId: body.releaseId!, issuedAt: body.issuedAt!, phase, migrations, reviewedMigrations: [...SITES_D1_FORWARD_ARTIFACT.migrations], schemaCheckpoints: [...SITES_D1_FORWARD_ARTIFACT.schemaCheckpoints], authorization });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch {
    return new Response("D1 forward operation failed", { status: 409, headers: { "cache-control": "no-store" } });
  }
}
