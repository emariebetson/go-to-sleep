import { env } from "cloudflare:workers";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { legacyHash, legacyInternalId, legacyText, legacyUuid } from "@/lib/nearlegacy-route";
import { nearLegacyReady, requireLegacyEntitlement } from "../production";

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request); if (!await nearLegacyReady()) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 });
    const { householdId, user } = await requireHouseholdContext(request, "archive:write"); if (!await requireLegacyEntitlement(householdId)) return jsonNoStore({ error: "NearLegacy is required." }, { status: 403 });
    let body: Record<string, unknown>; try { body = await readJsonObject(request, 3_000); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    const key = request.headers.get("idempotency-key") || ""; let id: string, contributorId: string, title: string; try { id = await legacyInternalId("interview", householdId, key); contributorId = legacyUuid(body.contributorId, "contributorId"); title = legacyText(body.title, "title", 160); } catch (error) { return badRequest(error); }
    const requestHash = await legacyHash(JSON.stringify({ contributorId, title, promptSetVersion: "guided-interview-v1" }));
    const prior = await env.DB.prepare("SELECT id,contributor_id,title,prompt_set_version,status,created_at,updated_at,request_hash FROM legacy_interviews WHERE household_id=? AND idempotency_key=?").bind(householdId, key.toLowerCase()).all();
    if (prior.results?.length) { const record = prior.results[0] as Record<string, unknown>; if (record.request_hash !== requestHash) return jsonNoStore({ error: "That idempotency key is already associated with different interview data." }, { status: 409 }); return jsonNoStore({ interview: record, duplicate: true }); }
    const contributor = await env.DB.prepare("SELECT id FROM contributors WHERE id=? AND household_id=? AND status='active'").bind(contributorId, householdId).all();
    if (!contributor.results?.length) return jsonNoStore({ error: "An active contributor in this household is required." }, { status: 404 });
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO legacy_interviews (id,household_id,contributor_id,created_by_user_id,title,idempotency_key,request_hash,prompt_set_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'guided-interview-v1','draft',?,?)").bind(id, householdId, contributorId, user.userId, title, key.toLowerCase(), requestHash, now, now),
      env.DB.prepare("INSERT INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(`${id}:created`, householdId, user.userId, "interview_created", "interview", id, requestHash, now),
    ]);
    const result = await env.DB.prepare("SELECT id,contributor_id,title,prompt_set_version,status,created_at,updated_at FROM legacy_interviews WHERE id=? AND household_id=?").bind(id, householdId).all();
    return jsonNoStore({ interview: result.results?.[0] }, { status: 201 });
  } catch (error) { return apiV1Failure(error, "Interview could not be created."); }
}
