import { env } from "cloudflare:workers";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { legacyHash, legacyInternalId, legacyText, optionalLegacyText } from "@/lib/nearlegacy-route";
import { nearLegacyReady, requireLegacyEntitlement } from "../production";

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request); if (!await nearLegacyReady()) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 });
    const { householdId, user } = await requireHouseholdContext(request, "archive:write"); if (!await requireLegacyEntitlement(householdId)) return jsonNoStore({ error: "NearLegacy is required." }, { status: 403 });
    let body: Record<string, unknown>; try { body = await readJsonObject(request, 3_000); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    let displayName: string, relationship: string | null; try { displayName = legacyText(body.displayName, "displayName", 120); relationship = optionalLegacyText(body.relationship, "relationship", 120); } catch (error) { return badRequest(error); }
    const selfContributor = body.selfContributor === true;
    if (selfContributor && relationship !== "self") return badRequest(new Error("A self contributor must use the relationship “self”."));
    let invitationId: string | null = null;
    if (!selfContributor) {
      try { invitationId = String(body.invitationId ? body.invitationId : "").trim(); if (!invitationId) throw new Error("A household invitation is required for a loved-one contributor."); } catch (error) { return badRequest(error); }
      const invitation = await env.DB.prepare("SELECT id FROM household_invitations WHERE id=? AND household_id=? AND role='contributor' AND status IN ('pending','accepted') AND expires_at>?").bind(invitationId, householdId, Date.now()).all();
      if (!invitation.results?.length) return jsonNoStore({ error: "A current household invitation is required for this contributor." }, { status: 409 });
    }
    const key = request.headers.get("idempotency-key") || ""; let id: string; try { id = await legacyInternalId("contributor", householdId, key); } catch (error) { return badRequest(error); }
    const requestHash = await legacyHash(JSON.stringify({ displayName, relationship, selfContributor, invitationId }));
    const existing = await env.DB.prepare("SELECT id,adult_user_id,display_name,relationship,status,request_hash FROM contributors WHERE household_id=? AND creation_idempotency_key=?").bind(householdId, key.toLowerCase()).all();
    if (existing.results?.length) {
      const record = existing.results[0] as Record<string, unknown>; if (record.request_hash !== requestHash) return jsonNoStore({ error: "That idempotency key is already associated with different contributor data." }, { status: 409 });
      return jsonNoStore({ contributor: record, duplicate: true });
    }
    const now = Date.now(); const status = selfContributor ? "active" : "invited"; const adultUserId = selfContributor ? user.userId : null;
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO contributors (id,household_id,adult_user_id,display_name,relationship,status,creation_idempotency_key,request_hash,invitation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(id, householdId, adultUserId, displayName, relationship, status, key.toLowerCase(), requestHash, invitationId, now, now),
        env.DB.prepare("INSERT INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(`${id}:created`, householdId, user.userId, selfContributor ? "self_contributor_created" : "contributor_invited", "contributor", id, requestHash, now),
      ]);
    } catch (error) {
      const raced = await env.DB.prepare("SELECT id,adult_user_id,display_name,relationship,status,request_hash FROM contributors WHERE household_id=? AND creation_idempotency_key=?").bind(householdId, key.toLowerCase()).all();
      const record = raced.results?.[0] as Record<string, unknown> | undefined; if (!record || record.request_hash !== requestHash) throw error;
      return jsonNoStore({ contributor: record, duplicate: true });
    }
    return jsonNoStore({ contributor: { id, adultUserId, displayName, relationship, status } }, { status: 201 });
  } catch (error) { return apiV1Failure(error, "Contributor could not be created."); }
}
