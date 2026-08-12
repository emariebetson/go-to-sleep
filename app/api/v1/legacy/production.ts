import { env } from "cloudflare:workers";
import { featureFlagsFromEnv, nearLegacyArchiveFlagsEnabled } from "@/lib/nearyou-foundation";
import { requireApiAuthContext } from "@/lib/auth";
import { revealTotpSecret, verifyTotp } from "@/lib/legacy-mfa";
import { legacyHash } from "@/lib/nearlegacy-route";
import { createPostgresHouseholdProductAccess } from "@/lib/product-release-readiness-service";

const HEARTBEAT_MAX_AGE_MS = 5 * 60_000;

export async function nearLegacyReady(mode: "worker" | "read" = "worker") {
  if (!nearLegacyArchiveFlagsEnabled(featureFlagsFromEnv(process.env))) return false;
  if (!/^[0-9a-f]{64}$/i.test(process.env.NEARYOU_MFA_ENCRYPTION_KEY || "")) return false;
  try { if (new URL(process.env.NEARYOU_LEGACY_MEDIA_PROCESSOR_URL || "").protocol !== "https:") return false; } catch { return false; }
  if (!/^[A-Za-z0-9._~+/-]{32,256}$/.test(process.env.NEARYOU_LEGACY_MEDIA_PROCESSOR_TOKEN || "")) return false;
  if (process.env.NEARYOU_LEGACY_PROCESSOR_ANTISPOOF_VERIFIED !== "true") return false;
  const result = await env.DB.prepare("SELECT status,migration_version,worker_heartbeat_at FROM legacy_activation_state WHERE id='archive'").all();
  const state = result.results?.[0] as { status?: string; migration_version?: string; worker_heartbeat_at?: number } | undefined;
  // Unresolved uploads are reconciled per operation. A single household's staged
  // object must never globally disable retries or reads for every household.
  return Boolean(state?.status === "ready" && state.migration_version === "0014" && (mode === "read" || (state.worker_heartbeat_at && state.worker_heartbeat_at >= Date.now() - HEARTBEAT_MAX_AGE_MS)));
}
export async function authorizeNearLegacyHousehold(householdId:string){const pg=(env as unknown as{READINESS_PG?:{query<T>(sql:string,args:unknown[]):Promise<{rows:T[]}>}}).READINESS_PG;return pg?createPostgresHouseholdProductAccess(pg)("nearlegacy",householdId):false}

export async function requireLegacyEntitlement(householdId: string, mode: "create" | "read" = "create") {
  const now = Date.now();
  const result = await env.DB.prepare(`SELECT id FROM entitlements WHERE household_id=? AND plan_id IN (${mode === "read" ? "'nearlegacy','archive_builder','archive_care'" : "'nearlegacy','archive_builder'"}) AND status IN ('active','grace') AND valid_from<=? AND (valid_until IS NULL OR valid_until>?) ORDER BY updated_at DESC LIMIT 1`).bind(householdId, now, now).all();
  return Boolean(result.results?.length);
}

export async function requireLegacyFreshAuth(request: Request, userId: string) {
  const challengeId = request.headers.get("x-nearyou-reauth-challenge")?.trim();
  if (!challengeId) return null;
  const auth = await requireApiAuthContext(request); if (auth.user.userId !== userId) return null;
  const row = await env.DB.prepare("SELECT id FROM account_reauth_challenges WHERE id=? AND user_id=? AND status='verified' AND verified_session_id=? AND expires_at>?").bind(challengeId, userId, auth.sessionId, Date.now()).all();
  if(!row.results?.length)return null;
  if(process.env.NEARYOU_REQUIRE_LEGACY_MFA==="true"){
    const code=request.headers.get("x-nearyou-mfa-code")?.trim()||"",enrollment=await env.DB.prepare("SELECT id,secret_ciphertext,secret_iv,last_used_counter FROM legacy_mfa_enrollments WHERE user_id=? AND status='active' LIMIT 1").bind(userId).all(),mfa=enrollment.results?.[0] as Record<string,unknown>|undefined,key=process.env.NEARYOU_MFA_ENCRYPTION_KEY||"";if(!mfa)return null;
    try{const secret=await revealTotpSecret(String(mfa.secret_ciphertext),String(mfa.secret_iv),key),counter=await verifyTotp(secret,code,Date.now(),Number(mfa.last_used_counter));if(counter!==null){const consumed=await env.DB.prepare("UPDATE legacy_mfa_enrollments SET last_used_counter=? WHERE id=? AND user_id=? AND status='active' AND last_used_counter<?").bind(counter,mfa.id,userId,counter).run();if(!consumed.meta.changes)return null;}else{const normalized=code.replaceAll("-","").trim().toUpperCase();if(!/^[A-Z0-9]{12}$/.test(normalized))return null;const hash=await legacyHash(normalized),used=await env.DB.prepare("UPDATE legacy_mfa_recovery_codes SET used_at=? WHERE enrollment_id=? AND user_id=? AND code_hash=? AND used_at IS NULL").bind(Date.now(),mfa.id,userId,hash).run();if(!used.meta.changes)return null;}}catch{return null;}
  }
  return { challengeId, sessionId: auth.sessionId };
}

export async function isLegacyCustodian(householdId: string, userId: string) {
  const row = await env.DB.prepare("SELECT id FROM legacy_custodians WHERE household_id=? AND user_id=? AND role='primary' AND status='active' LIMIT 1").bind(householdId, userId).all();
  return Boolean(row.results?.length);
}
