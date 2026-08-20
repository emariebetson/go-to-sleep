import { createServiceOidcAuthenticator } from "./service-oidc";
import { env } from "cloudflare:workers";

type Statement = { bind(...values: unknown[]): Statement; first<T>(): Promise<T | null>; run(): Promise<unknown> };
type D1 = { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown[]> };
type Pg = { query<T>(sql: string, args: unknown[]): Promise<{ rows: T[] }> };
type Plan = "nearyou_plus" | "nearyou_family";
type PublicInput = {
  action: "issue" | "revoke";
  householdId: string;
  releaseId: string;
  reason: string;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  idempotencyKey: string;
  planId?: Plan;
  entitlementId?: string;
};
type Input = PublicInput & { principal: string };
type Audit = { operation: "issue" | "revoke"; entitlement_id: string; household_id: string; plan_id: Plan; release_id: string; issued_at: number; not_before: number; expires_at: number; request_digest: string };
type Runtime = { DB: D1; READINESS_PG: Pg; CANARY_OIDC_ISSUER: string; CANARY_OIDC_AUDIENCE: string; CANARY_OIDC_SUBJECT: string; CANARY_OIDC_JWKS_URL: string };

const encoder = new TextEncoder();
const ID = /^[A-Za-z0-9_-]{3,200}$/;
const RELEASE = /^rel_[A-Za-z0-9_-]{8,96}$/;
const KEY = /^[A-Za-z0-9_-]{16,120}$/;
const PRINCIPAL = /^service:[A-Za-z0-9_-]{3,100}$/;

async function sha256(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
function safeTime(value: number) { return Number.isSafeInteger(value) && value >= 0; }
function canonical(input: Input) { return JSON.stringify(Object.fromEntries(Object.entries(input).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))); }
function validate(input: Input, now: number) {
  if (!ID.test(input.householdId) || !RELEASE.test(input.releaseId) || !PRINCIPAL.test(input.principal) || !KEY.test(input.idempotencyKey)) throw new Error("canary entitlement invalid");
  if (input.reason !== input.reason.trim() || encoder.encode(input.reason).byteLength < 1 || encoder.encode(input.reason).byteLength > 240) throw new Error("canary entitlement invalid");
  if (![input.issuedAt, input.notBefore, input.expiresAt, now].every(safeTime) || input.issuedAt > now + 30_000 || input.issuedAt < now - 300_000 || input.notBefore < input.issuedAt || input.notBefore > now + 30_000 || input.expiresAt <= now || input.expiresAt - input.issuedAt > 86_400_000) throw new Error("canary entitlement invalid");
  if (input.action === "issue" && !(["nearyou_plus", "nearyou_family"] as unknown[]).includes(input.planId)) throw new Error("canary entitlement invalid");
  if (input.action === "revoke" && (!input.entitlementId || !ID.test(input.entitlementId))) throw new Error("canary entitlement invalid");
}
function operationResult(row: Audit) {
  return { operation: row.operation, entitlementId: row.entitlement_id, householdId: row.household_id, planId: row.plan_id, releaseId: row.release_id, issuedAt: Number(row.issued_at), notBefore: Number(row.not_before), expiresAt: Number(row.expires_at), requestDigest: row.request_digest, status: row.operation === "issue" ? "active" as const : "revoked" as const };
}
async function loadAudit(db: D1, key: string) {
  return db.prepare("SELECT operation,entitlement_id,household_id,plan_id,release_id,issued_at,not_before,expires_at,request_digest FROM canary_entitlement_audit WHERE idempotency_key=?").bind(key).first<Audit>();
}
async function replay(db: D1, key: string, requestDigest: string) {
  const row = await loadAudit(db, key);
  if (!row || row.request_digest !== requestDigest) throw new Error("canary entitlement idempotency conflict");
  return operationResult(row);
}
async function mutate(db: D1, publicInput: PublicInput, principal: string, now: number) {
  const input: Input = { ...publicInput, principal };
  validate(input, now);
  const requestDigest = await sha256(canonical(input));
  if (await loadAudit(db, input.idempotencyKey)) return replay(db, input.idempotencyKey, requestDigest);
  let entitlementId: string;
  let planId: Plan;
  const statements: Statement[] = [];
  if (input.action === "issue") {
    entitlementId = `canary_${requestDigest.slice(0, 40)}`;
    planId = input.planId!;
    const allowance = planId === "nearyou_family" ? 120_000 : 60_000;
    statements.push(db.prepare("INSERT INTO entitlements(id,household_id,plan_id,source,status,allowance_milliunits,remaining_milliunits,external_ref,valid_from,valid_until,created_at,updated_at) VALUES(?,?,?,'canary','active',?,?,?, ?,?,?,?)").bind(entitlementId, input.householdId, planId, allowance, allowance, `canary:${requestDigest}`, input.notBefore, input.expiresAt, now, now));
  } else {
    entitlementId = input.entitlementId!;
    const entitlement = await db.prepare("SELECT e.plan_id FROM entitlements e JOIN canary_entitlement_audit a ON a.entitlement_id=e.id AND a.operation='issue' WHERE e.id=? AND e.household_id=? AND e.source='canary' AND a.release_id=? AND e.status='active'").bind(entitlementId, input.householdId, input.releaseId).first<{ plan_id: Plan }>();
    if (!entitlement) throw new Error("canary entitlement invalid");
    planId = entitlement.plan_id;
  }
  statements.push(db.prepare("INSERT INTO canary_entitlement_audit(id,operation,entitlement_id,household_id,plan_id,release_id,principal,reason,issued_at,not_before,expires_at,idempotency_key,request_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(`audit_${requestDigest.slice(0, 40)}`, input.action, entitlementId, input.householdId, planId, input.releaseId, input.principal, input.reason, input.issuedAt, input.notBefore, input.expiresAt, input.idempotencyKey, requestDigest, now));
  if (input.action === "revoke") statements.push(db.prepare("UPDATE entitlements SET status='revoked',updated_at=? WHERE id=? AND household_id=? AND source='canary' AND status='active'").bind(now, entitlementId, input.householdId));
  try { await db.batch(statements); }
  catch (error) { if (!await loadAudit(db, input.idempotencyKey)) throw error; }
  return replay(db, input.idempotencyKey, requestDigest);
}
async function loadVerifiedInvite(pg: Pg, householdId: string, releaseId: string, now: number) {
  if (!ID.test(householdId) || !RELEASE.test(releaseId) || !safeTime(now)) throw new Error("canary verification invalid");
  const householdHash = await sha256(householdId);
  const row = (await pg.query<{ expires_at: string | number | Date }>("SELECT expires_at FROM nearyou.product_canary_invites WHERE product='nearfamily' AND release_id=$1 AND household_hash=$2 AND expires_at>to_timestamp($3::double precision/1000)", [releaseId, householdHash, now])).rows[0];
  const expiresAt = row?.expires_at instanceof Date ? row.expires_at.getTime() : typeof row?.expires_at === "string" ? Date.parse(row.expires_at) : Number(row?.expires_at);
  if (!safeTime(expiresAt) || expiresAt <= now) throw new Error("canary verification unavailable");
  return { householdHash, expiresAt };
}
async function verify(db: D1, pg: Pg, input: { householdId: string; releaseId: string }, now: number) {
  const invite = await loadVerifiedInvite(pg, input.householdId, input.releaseId, now);
  const row = await db.prepare("SELECT e.id,e.plan_id,e.source,e.status,e.valid_from,e.valid_until,a.release_id FROM entitlements e JOIN canary_entitlement_audit a ON a.entitlement_id=e.id AND a.operation='issue' WHERE e.household_id=? AND e.source='canary' AND e.status='active' AND e.valid_from<=? AND e.valid_until>? AND a.release_id=? ORDER BY e.created_at DESC,e.id DESC LIMIT 1").bind(input.householdId, now, now, input.releaseId).first<{ id: string; plan_id: Plan; source: "canary"; status: "active"; valid_from: number; valid_until: number; release_id: string }>();
  if (!row) throw new Error("canary verification unavailable");
  return { entitlementId: row.id, householdId: input.householdId, planId: row.plan_id, source: row.source, status: row.status, releaseId: row.release_id, notBefore: Number(row.valid_from), expiresAt: Number(row.valid_until), rolloutInvite: { product: "nearfamily" as const, releaseId: input.releaseId, householdHash: invite.householdHash, expiresAt: invite.expiresAt } };
}

function createPrivateCanaryEntitlementService(runtime: Runtime) {
  const authenticate = createServiceOidcAuthenticator({ issuer: runtime.CANARY_OIDC_ISSUER, audience: runtime.CANARY_OIDC_AUDIENCE, subject: runtime.CANARY_OIDC_SUBJECT, jwksUrl: runtime.CANARY_OIDC_JWKS_URL, clock: { now: async () => Date.now() } });
  const authorizations = new WeakSet<object>();
  return Object.freeze({
    authorize: async (request: Request) => { const identity = await authenticate(request); const authorization = Object.freeze({ principal: identity.principal }); authorizations.add(authorization); return authorization; },
    mutate: async (authorization: { principal: string }, input: PublicInput) => { if (!authorizations.has(authorization)) throw new Error("canary entitlement unauthorized"); return mutate(runtime.DB, input, authorization.principal, Date.now()); },
    verify: async (authorization: object, input: { householdId: string; releaseId: string }) => { if (!authorizations.has(authorization)) throw new Error("canary entitlement unauthorized"); return verify(runtime.DB, runtime.READINESS_PG, input, Date.now()); },
  });
}

const runtime = env as unknown as Runtime;
export const privateCanaryEntitlementService = createPrivateCanaryEntitlementService(runtime);
