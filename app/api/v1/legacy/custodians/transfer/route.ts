import { env } from "cloudflare:workers";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { legacyHash, legacyInternalId, legacyUuid } from "@/lib/nearlegacy-route";
import { isLegacyCustodian, nearLegacyReady, requireLegacyEntitlement, requireLegacyFreshAuth } from "../../production";

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request); if (!await nearLegacyReady("read")) return jsonNoStore({error:"NearLegacy is not available."},{status:404});
    const {householdId,user}=await requireHouseholdContext(request,"archive:read"); if(!await requireLegacyEntitlement(householdId, "read")) return jsonNoStore({error:"NearLegacy is required."},{status:403});
    if(!await isLegacyCustodian(householdId,user.userId)) return jsonNoStore({error:"Only the active primary custodian may transfer custody."},{status:403});
    let body:Record<string,unknown>; try{body=await readJsonObject(request,1000);}catch(error){return error instanceof Response?error:badRequest(error);}
    const to=legacyUuid(body.toCustodianId,"toCustodianId"); const key=request.headers.get("idempotency-key")||""; const id=await legacyInternalId("custodian-transfer",householdId,key); const requestHash=await legacyHash(to);
    const prior=await env.DB.prepare("SELECT t.id,t.to_custodian_id,t.status,t.completed_at,a.request_hash FROM legacy_custodian_transfers t JOIN legacy_audit_events a ON a.id=t.id||':requested' AND a.household_id=t.household_id WHERE t.id=? AND t.household_id=?").bind(id,householdId).all();
    if(prior.results?.length){const p=prior.results[0] as Record<string,unknown>; if(p.to_custodian_id!==to||p.request_hash!==requestHash)return jsonNoStore({error:"That idempotency key belongs to another custody transfer."},{status:409}); return jsonNoStore({transfer:p,duplicate:true});}
    const fresh=await requireLegacyFreshAuth(request,user.userId);if(!fresh)return jsonNoStore({error:"The active primary custodian must complete a fresh sign-in."},{status:403});
    const from=await env.DB.prepare("SELECT id FROM legacy_custodians WHERE household_id=? AND user_id=? AND role='primary' AND status='active'").bind(householdId,user.userId).all(); if(!from.results?.length) return jsonNoStore({error:"Only the active primary custodian can transfer custody."},{status:403});
    const now=Date.now(); await env.DB.batch([
      env.DB.prepare("INSERT INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES (?,?,?,'custody_transfer_requested','custodian',?,?,?)").bind(`${id}:requested`,householdId,user.userId,to,requestHash,now),
      env.DB.prepare("INSERT INTO legacy_custodian_transfers (id,household_id,from_custodian_id,to_custodian_id,requested_by_user_id,status,reauth_challenge_id,reauth_session_id,created_at) VALUES (?,?,?,?,?,'requested',?,?,?)").bind(id,householdId,from.results[0].id,to,user.userId,fresh.challengeId,fresh.sessionId,now),
    ]); const row=await env.DB.prepare("SELECT id,status,completed_at FROM legacy_custodian_transfers WHERE id=? AND household_id=?").bind(id,householdId).all(); return jsonNoStore({transfer:row.results?.[0]});
  }catch(error){return apiV1Failure(error,"Custody could not be transferred.");}
}
