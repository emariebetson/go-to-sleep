import { env } from "cloudflare:workers";
import { apiV1Failure, badRequest } from "@/lib/api-v1-context";
import { requireApiAuthContext } from "@/lib/auth";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { enforceLegacyRateLimit, legacyHash, legacyInternalId, legacyUuid } from "@/lib/nearlegacy-route";
import { isLegacyCustodian, requireLegacyFreshAuth } from "../production";

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request); const { user }=await requireApiAuthContext(request);const householdId=request.headers.get("x-nearyou-household-id")?.trim()||"";if(!/^[A-Za-z0-9:_-]{1,200}$/.test(householdId))return badRequest(new Error("A household is required."));const member=await env.DB.prepare("SELECT role FROM household_members WHERE household_id=? AND user_id=? AND status='active'").bind(householdId,user.userId).all();const role=String((member.results?.[0] as Record<string,unknown>|undefined)?.role||""); const limited=await enforceLegacyRateLimit(env.DB,householdId,user.userId,"deletion",3,3600_000);if(limited)return limited;
    let body: Record<string, unknown>; try { body = await readJsonObject(request, 1000); } catch (error) { return error instanceof Response ? error : badRequest(error); } const targetKind = body.targetKind; if (!['recording','contributor','archive'].includes(String(targetKind))) return badRequest(new Error("targetKind must be recording, contributor, or archive."));
    const targetId = targetKind === "archive" ? householdId : legacyUuid(body.targetId, "targetId");
    const selfContributor = await env.DB.prepare("SELECT id FROM contributors WHERE id=? AND household_id=? AND adult_user_id=? AND status IN ('active','deceased_pending_review')").bind(targetId, householdId, user.userId).all();
    const recording = targetKind === "recording" ? await env.DB.prepare("SELECT r.id,n.adult_user_id FROM legacy_recordings r JOIN contributors n ON n.id=r.contributor_id AND n.household_id=r.household_id WHERE r.id=? AND r.household_id=? AND r.status<>'deleted'").bind(targetId,householdId).all() : null;
    if(targetKind==='contributor'&&!selfContributor.results?.length){const exists=await env.DB.prepare("SELECT id FROM contributors WHERE id=? AND household_id=?").bind(targetId,householdId).all();if(!exists.results?.length)return jsonNoStore({error:"Contributor not found."},{status:404});}if(targetKind==='recording'&&!recording?.results?.length)return jsonNoStore({error:"Recording not found."},{status:404});
    const ownRecording=recording?.results?.[0]&&String((recording.results[0] as Record<string,unknown>).adult_user_id)===user.userId;
    const mayDelete = targetKind === "archive" ? role === "owner" || await isLegacyCustodian(householdId,user.userId) : targetKind === "contributor" ? Boolean(selfContributor.results?.length) || role === "owner" || await isLegacyCustodian(householdId,user.userId) : ownRecording || role === "owner" || role === "adult_manager" || await isLegacyCustodian(householdId,user.userId);
    if (!mayDelete) return jsonNoStore({error:"You cannot delete this archive resource."},{status:403});
    const key = request.headers.get("idempotency-key") || ""; let id: string; try { id = await legacyInternalId("deletion", householdId, key); } catch (error) { return badRequest(error); } const hash = await legacyHash(JSON.stringify({ targetKind, targetId })); const now = Date.now();
    const prior=await env.DB.prepare("SELECT id,target_kind,target_id,request_hash,status,created_at,updated_at FROM legacy_deletion_operations WHERE id=? AND household_id=?").bind(id,householdId).all();if(prior.results?.length){const p=prior.results[0] as Record<string,unknown>;if(p.request_hash!==hash||p.target_kind!==targetKind||p.target_id!==targetId)return jsonNoStore({error:"That idempotency key belongs to another deletion."},{status:409});return jsonNoStore({deletion:p,duplicate:true});}
    const freshAuth=await requireLegacyFreshAuth(request,user.userId); if (body.confirmation !== "DELETE ARCHIVE DATA" || !freshAuth) return jsonNoStore({error:"Type DELETE ARCHIVE DATA and complete a fresh sign-in."},{status:403});
    await env.DB.batch([
      env.DB.prepare("INSERT INTO legacy_deletion_operations (id,household_id,requested_by_user_id,target_kind,target_id,request_hash,reauth_challenge_id,reauth_session_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'queued',?,?)").bind(id, householdId, user.userId, targetKind, targetId,hash,freshAuth.challengeId,freshAuth.sessionId,now, now),
      env.DB.prepare("INSERT OR IGNORE INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES (?,?,?,'deletion_requested',?,?,?,?)").bind(`${id}:requested`, householdId, user.userId, targetKind, targetId, hash, now),
    ]);
    const row = await env.DB.prepare("SELECT id,target_kind,target_id,status,created_at,updated_at FROM legacy_deletion_operations WHERE id=? AND household_id=?").bind(id, householdId).all(); return jsonNoStore({ deletion: row.results?.[0] }, { status: 202 });
  } catch (error) { return apiV1Failure(error, "Archive deletion could not be requested."); }
}
