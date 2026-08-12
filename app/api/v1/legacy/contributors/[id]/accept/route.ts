import { env } from "cloudflare:workers";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore } from "@/lib/http";
import { legacyHash, legacyUuid } from "@/lib/nearlegacy-route";
import { nearLegacyReady, requireLegacyEntitlement } from "../../../production";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedMutationOrigin(request); if (!await nearLegacyReady()) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 });
    const { householdId, user } = await requireHouseholdContext(request, "archive:self"); if (!await requireLegacyEntitlement(householdId)) return jsonNoStore({ error: "NearLegacy is required." }, { status: 403 });
    const id = legacyUuid((await params).id, "contributorId"); const key = request.headers.get("idempotency-key") || ""; legacyUuid(key, "Idempotency-Key"); const eventId = `${id}:accept:${key.toLowerCase()}`; const now = Date.now(); const requestHash = await legacyHash(`${householdId}:${id}:${user.userId}`);
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(eventId, householdId, user.userId, "contributor_acceptance", "contributor", id, requestHash, now),
      env.DB.prepare("UPDATE contributors SET adult_user_id=?,status='active',updated_at=? WHERE id=? AND household_id=? AND adult_user_id IS NULL AND status='invited'").bind(user.userId, now, id, householdId),
    ]);
    const result = await env.DB.prepare("SELECT id,adult_user_id,display_name,relationship,status FROM contributors WHERE id=? AND household_id=?").bind(id, householdId).all();
    const record = result.results?.[0] as Record<string, unknown> | undefined; if (!record || record.adult_user_id !== user.userId || record.status !== "active") return jsonNoStore({ error: "This contributor invitation is unavailable." }, { status: 409 });
    return jsonNoStore({ contributor: record });
  } catch (error) { return apiV1Failure(error, "Contributor invitation could not be accepted."); }
}
