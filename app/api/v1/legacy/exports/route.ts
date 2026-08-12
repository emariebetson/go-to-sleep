import { env } from "cloudflare:workers";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore } from "@/lib/http";
import { enforceLegacyRateLimit, legacyHash, legacyInternalId } from "@/lib/nearlegacy-route";
import { isLegacyCustodian, nearLegacyReady, requireLegacyEntitlement, requireLegacyFreshAuth } from "../production";

export async function GET(request: Request) {
  try { if (!await nearLegacyReady("read")) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 }); const { householdId,user,role } = await requireHouseholdContext(request, "archive:read"); if (!await requireLegacyEntitlement(householdId, "read")) return jsonNoStore({ error: "NearLegacy is required." }, { status: 403 });if(role!=="owner"&&!await isLegacyCustodian(householdId,user.userId))return jsonNoStore({error:"Only the owner or primary custodian may view archive exports."},{status:403}); const rows = await env.DB.prepare("SELECT id,status,part_count,manifest_checksum,expires_at,created_at,updated_at FROM legacy_export_operations WHERE household_id=? ORDER BY created_at DESC LIMIT 20").bind(householdId).all();const parts=await env.DB.prepare("SELECT id,export_id,ordinal,checksum,byte_size FROM legacy_export_parts WHERE household_id=? AND status='ready' ORDER BY export_id,ordinal LIMIT 2000").bind(householdId).all(); return jsonNoStore({ exports: (rows.results || []).map(raw=>{const row=raw as Record<string,unknown>;return{...row,parts:(parts.results||[]).filter(part=>(part as Record<string,unknown>).export_id===row.id).map(part=>{const item=part as Record<string,unknown>;return{...item,downloadUrl:`/api/v1/legacy/exports/${row.id}/parts/${item.id}`};})};}) }); } catch (error) { return apiV1Failure(error, "Archive exports could not be loaded."); }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request); if (!await nearLegacyReady()) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 }); const { householdId, user, role } = await requireHouseholdContext(request, "archive:read"); const limited=await enforceLegacyRateLimit(env.DB,householdId,user.userId,"export",2,3600_000);if(limited)return limited; if (!await requireLegacyEntitlement(householdId, "read")) return jsonNoStore({ error: "NearLegacy is required." }, { status: 403 });
    if (role !== "owner" && !await isLegacyCustodian(householdId, user.userId)) return jsonNoStore({ error: "Only the owner or primary custodian may export the family archive." }, { status: 403 });
    const key = request.headers.get("idempotency-key") || ""; let id: string; try { id = await legacyInternalId("export", householdId, key); } catch (error) { return badRequest(error); } const now = Date.now(); const hash = await legacyHash("portable-archive-v1");
    const prior=await env.DB.prepare("SELECT id,status,expires_at,created_at,request_hash FROM legacy_export_operations WHERE id=? AND household_id=?").bind(id,householdId).all();if(prior.results?.length){const p=prior.results[0] as Record<string,unknown>;if(p.request_hash!==hash)return jsonNoStore({error:"That idempotency key belongs to another export."},{status:409});return jsonNoStore({export:p,duplicate:true});}
    const freshAuth=await requireLegacyFreshAuth(request, user.userId); if (!freshAuth) return jsonNoStore({ error: "A fresh sign-in is required." }, { status: 403 });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO legacy_export_operations (id,household_id,requested_by_user_id,request_hash,status,snapshot_at,part_count,expires_at,reauth_challenge_id,reauth_session_id,created_at,updated_at) VALUES (?,?,?,?,'queued',?,0,?,?,?,?,?)").bind(id, householdId, user.userId,hash, now, now + 7 * 86400000, freshAuth.challengeId,freshAuth.sessionId,now, now),
      // Bind the snapshot to every currently-active archive consent before any
      // worker can copy a source object. Revocation can now fence all phases.
      env.DB.prepare("INSERT INTO legacy_export_consents (household_id,export_id,consent_id) SELECT household_id,?,id FROM legacy_consents WHERE household_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)").bind(id,householdId,now),
      env.DB.prepare("INSERT OR IGNORE INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES (?,?,?,'export_requested','export',?,?,?)").bind(`${id}:requested`, householdId, user.userId, id, hash, now),
    ]);
    const row = await env.DB.prepare("SELECT id,status,expires_at,created_at FROM legacy_export_operations WHERE id=? AND household_id=?").bind(id, householdId).all(); return jsonNoStore({ export: row.results?.[0] }, { status: 202 });
  } catch (error) { return apiV1Failure(error, "Archive export could not be requested."); }
}
