import { env } from "cloudflare:workers";
import { apiV1Failure } from "@/lib/api-v1-context";
import { requireApiAuthContext } from "@/lib/auth";
import { assertTrustedMutationOrigin, jsonNoStore } from "@/lib/http";
import { legacyHash, legacyInternalId } from "@/lib/nearlegacy-route";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedMutationOrigin(request);
    const { user } = await requireApiAuthContext(request); const householdId=request.headers.get("x-nearyou-household-id")?.trim()||"";if(!/^[A-Za-z0-9:_-]{1,200}$/.test(householdId))return jsonNoStore({error:"A household is required."},{status:400});
    const { id } = await context.params; const key = request.headers.get("idempotency-key") || ""; const auditId = await legacyInternalId("consent-revoke", householdId, key); const requestHash = await legacyHash(`${id}:revoke`); const now = Date.now();
    const consent = await env.DB.prepare("SELECT c.id,c.status,n.adult_user_id FROM legacy_consents c JOIN contributors n ON n.id=c.contributor_id AND n.household_id=c.household_id WHERE c.id=? AND c.household_id=?").bind(id, householdId).all();
    const row = consent.results?.[0] as { status?: string; adult_user_id?: string } | undefined; if (!row) return jsonNoStore({ error: "Consent not found." }, { status: 404 });
    if (row.adult_user_id !== user.userId) return jsonNoStore({ error: "Only the contributor may revoke their consent." }, { status: 403 });
    await env.DB.prepare("INSERT OR IGNORE INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES (?,?,?,'consent_revocation_requested','consent',?,?,?)").bind(auditId, householdId, user.userId, id, requestHash, now).run();
    const receipt = await env.DB.prepare("SELECT target_id,request_hash,actor_user_id FROM legacy_audit_events WHERE id=? AND household_id=?").bind(auditId, householdId).all();
    const receiptRow = receipt.results?.[0] as { target_id?: string; request_hash?: string; actor_user_id?: string } | undefined;
    if (!receiptRow || receiptRow.target_id !== id || receiptRow.request_hash !== requestHash || receiptRow.actor_user_id !== user.userId) return jsonNoStore({ error: "That idempotency key is already associated with a different consent action." }, { status: 409 });
    await env.DB.prepare("UPDATE legacy_consents SET status='revoked',revoked_at=? WHERE id=? AND household_id=? AND status='active'").bind(now, id, householdId).run();
    const updated = await env.DB.prepare("SELECT id,status,revoked_at FROM legacy_consents WHERE id=? AND household_id=?").bind(id, householdId).all();
    return jsonNoStore({ consent: updated.results?.[0] });
  } catch (error) { return apiV1Failure(error, "Consent could not be revoked."); }
}
