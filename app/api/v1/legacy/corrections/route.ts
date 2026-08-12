import { env } from "cloudflare:workers";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { parseTranscriptCorrection } from "@/lib/nearlegacy";
import { legacyHash, legacyInternalId, legacyUuid } from "@/lib/nearlegacy-route";
import { nearLegacyReady, requireLegacyEntitlement } from "../production";

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request); if (!await nearLegacyReady()) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 });
    const { householdId, user } = await requireHouseholdContext(request, "archive:write"); if (!await requireLegacyEntitlement(householdId)) return jsonNoStore({ error: "NearLegacy is required." }, { status: 403 });
    let body: Record<string, unknown>; try { body = await readJsonObject(request, 6_000); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    const key = request.headers.get("idempotency-key") || ""; let id: string, correction: ReturnType<typeof parseTranscriptCorrection>; try { id = await legacyInternalId("correction", householdId, key); correction = parseTranscriptCorrection(body); correction.segmentId = legacyUuid(correction.segmentId, "segmentId"); correction.speakerContributorId = legacyUuid(correction.speakerContributorId, "speakerContributorId"); } catch (error) { return badRequest(error); }
    const requestHash = await legacyHash(JSON.stringify(correction));
    const prior = await env.DB.prepare("SELECT id,segment_id,speaker_contributor_id,corrected_text,reason,created_at,request_hash FROM legacy_transcript_corrections WHERE household_id=? AND idempotency_key=?").bind(householdId, key.toLowerCase()).all();
    if (prior.results?.length) { const record = prior.results[0] as Record<string, unknown>; if (record.request_hash !== requestHash) return jsonNoStore({ error: "That idempotency key is already associated with a different correction." }, { status: 409 }); return jsonNoStore({ correction: record, duplicate: true }); }
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO legacy_transcript_corrections (id,household_id,segment_id,corrected_by_user_id,speaker_contributor_id,corrected_text,reason,idempotency_key,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id, householdId, correction.segmentId, user.userId, correction.speakerContributorId, correction.correctedText, correction.reason, key.toLowerCase(), requestHash, now),
      env.DB.prepare("INSERT INTO legacy_audit_events (id,household_id,actor_user_id,event_type,target_kind,target_id,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(`${id}:created`, householdId, user.userId, "transcript_corrected", "transcript_segment", correction.segmentId, requestHash, now),
    ]);
    const result = await env.DB.prepare("SELECT id,segment_id,speaker_contributor_id,corrected_text,reason,created_at FROM legacy_transcript_corrections WHERE id=? AND household_id=?").bind(id, householdId).all();
    return jsonNoStore({ correction: result.results?.[0] }, { status: 201 });
  } catch (error) { return apiV1Failure(error, "Transcript correction could not be saved."); }
}
