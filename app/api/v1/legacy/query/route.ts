import { env } from "cloudflare:workers";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { buildGroundedArchiveAnswer, LEGACY_NO_EVIDENCE_RESPONSE, type LegacySourceSegment } from "@/lib/nearlegacy";
import { nearLegacyReady, requireLegacyEntitlement } from "../production";
import { enforceLegacyRateLimit, legacyInternalId } from "@/lib/nearlegacy-route";

function cleanQuery(value: unknown) {
  if (typeof value !== "string") throw new Error("question is required.");
  const normalized = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!normalized || Array.from(normalized).length > 500 || /\p{Cc}/u.test(normalized)) throw new Error("question must be at most 500 characters.");
  return normalized;
}
async function sha256(value: string) { const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    if (!await nearLegacyReady("read")) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 });
    const { householdId, user } = await requireHouseholdContext(request, "archive:read");
    const limited = await enforceLegacyRateLimit(env.DB, householdId, user.userId, "query", 30, 60_000); if (limited) return limited;
    if (!await requireLegacyEntitlement(householdId, "read")) return jsonNoStore({ error: "NearLegacy is not included in this household plan." }, { status: 403 });
    let body: Record<string, unknown>; try { body = await readJsonObject(request, 2_000); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    let question: string; try { question = cleanQuery(body.question); } catch (error) { return badRequest(error); }
    const clientKey = request.headers.get("idempotency-key")?.trim() || "";
    if (!/^[0-9a-f-]{36}$/i.test(clientKey)) return jsonNoStore({ error: "A UUID Idempotency-Key is required." }, { status: 400 });
    const requestId = await legacyInternalId(`query:${user.userId}`, householdId, clientKey);
    const questionNormalized = question.toLocaleLowerCase(); const questionHash = await sha256(questionNormalized);
    const stopWords = new Set(["the","and","for","with","from","that","this","what","when","where","which","who","why","how","did","does","about","tell","was","were","are","our","your"]);
    const tokens = [...new Set(questionNormalized.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3 && !stopWords.has(token)))].slice(0, 8);
    const variants = (token:string) => token === "meet" ? ["meet","met"] : token === "tell" ? ["tell","told"] : [token];
    const searchTerms = [...new Set(tokens.flatMap(variants))];
    const where = searchTerms.length ? searchTerms.map(() => "(lower(s.effective_text) LIKE ? ESCAPE '\\' OR lower(n.display_name) LIKE ? ESCAPE '\\' OR lower(COALESCE(n.relationship,'')) LIKE ? ESCAPE '\\')").join(" OR ") : "0";
    const likes = searchTerms.flatMap((token) => Array(3).fill(`%${token.replace(/[\\%_]/g, "\\$&")}%`));
    const result = await env.DB.prepare(`SELECT s.id AS segmentId,s.transcript_id AS transcriptId,(SELECT x.id FROM legacy_transcript_corrections x WHERE x.household_id=s.household_id AND x.segment_id=s.id ORDER BY x.created_at DESC,x.id DESC LIMIT 1) AS correctionId,s.recording_id AS recordingId,s.contributor_id AS contributorId,n.display_name AS contributorName,n.relationship AS contributorRelationship,r.recorded_at AS recordedAt,s.start_ms AS startMs,s.end_ms AS endMs,s.effective_text AS transcript,m.checksum AS checksum FROM legacy_transcript_segments s JOIN legacy_transcripts t ON t.id=s.transcript_id AND t.household_id=s.household_id JOIN legacy_recordings r ON r.id=s.recording_id AND r.household_id=s.household_id JOIN contributors n ON n.id=s.contributor_id AND n.household_id=s.household_id JOIN legacy_consents c ON c.id=r.consent_id AND c.household_id=r.household_id JOIN legacy_consents tc ON tc.id=t.consent_id AND tc.household_id=t.household_id JOIN media_assets m ON m.id=r.media_asset_id AND m.household_id=r.household_id WHERE s.household_id=? AND s.status='ready' AND t.status='ready' AND r.status='ready' AND n.status IN ('active','deceased_pending_review') AND c.status='active' AND tc.status='active' AND (c.expires_at IS NULL OR c.expires_at>?) AND (tc.expires_at IS NULL OR tc.expires_at>?) AND EXISTS (SELECT 1 FROM legacy_consents sc WHERE sc.household_id=s.household_id AND sc.contributor_id=s.contributor_id AND sc.kind='transcription' AND sc.status='active' AND (sc.expires_at IS NULL OR sc.expires_at>?)) AND m.status='ready' AND m.private=1 AND NOT EXISTS (SELECT 1 FROM legacy_deletion_operations d WHERE d.household_id=s.household_id AND d.status IN ('queued','processing','failed','dead_letter') AND (d.target_kind='archive' OR (d.target_kind='contributor' AND d.target_id=s.contributor_id) OR (d.target_kind='recording' AND d.target_id=r.id))) AND (${where}) ORDER BY r.recorded_at DESC,s.ordinal LIMIT 12`).bind(householdId, Date.now(), Date.now(), Date.now(), ...likes).all();
    const rawQueryTokens = new Set(questionNormalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const identityTerms = new Set((result.results || []).flatMap((row) => [String((row as Record<string,unknown>).contributorName || ""), String((row as Record<string,unknown>).contributorRelationship || "")]).flatMap((value) => value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u)).filter((term) => term.length >= 3 && rawQueryTokens.has(term)));
    const candidates = (result.results || []).map((row) => {
      const item = row as Record<string, unknown>;
      const transcript = String(item.transcript).toLocaleLowerCase(); const candidateIdentity = `${item.contributorName || ""} ${item.contributorRelationship || ""}`.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u); const identityMatch = identityTerms.size === 0 || candidateIdentity.some((term) => identityTerms.has(term)); const matched = tokens.filter((token) => variants(token).some((variant)=>new RegExp(`(^|[^\\p{L}\\p{N}])${variant}([^\\p{L}\\p{N}]|$)`,`u`).test(transcript)) || candidateIdentity.includes(token)).length; const coverage = tokens.length ? matched / tokens.length : 0; const exactPhrase = tokens.length >= 2 && transcript.includes(tokens.join(" "));
      return { ...item, recordedAt: new Date(Number(item.recordedAt)).toISOString(), score: identityMatch && exactPhrase ? .98 : identityMatch && matched >= 2 && coverage >= .6 ? .72 + coverage * .2 : 0, provenance: "original_recording", status: "ready", deletionStatus: "active", matchedQuery: question } as LegacySourceSegment;
    });
    const answer = buildGroundedArchiveAnswer(question, candidates);
    const selected = answer.supported ? candidates.find((candidate) => candidate.segmentId === answer.sources[0].segmentId)! : null;
    const answerChecksum = await sha256(answer.answer);
    await env.DB.prepare("INSERT OR IGNORE INTO legacy_query_receipts (id,household_id,requested_by_user_id,question_hash,supported,answer_kind,status,answer_text,answer_checksum,selected_segment_id,selected_transcript_id,selected_correction_id,selected_recording_id,selected_score_micros,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(requestId, householdId, user.userId, questionHash, answer.supported ? 1 : 0, answer.supported ? "original_recording" : "no_evidence", answer.supported ? "building" : "ready", answer.answer, answerChecksum, selected?.segmentId || null, selected?.transcriptId || null, selected?.correctionId || null, selected?.recordingId || null, selected ? Math.round(selected.score * 1_000_000) : null, Date.now(), answer.supported ? null : Date.now()).run();
    const storedResult = await env.DB.prepare("SELECT question_hash,supported,answer_kind,status,answer_text,answer_checksum,selected_segment_id,selected_transcript_id,selected_correction_id,selected_recording_id,selected_score_micros FROM legacy_query_receipts WHERE id=? AND household_id=?").bind(requestId, householdId).all();
    const stored = storedResult.results?.[0] as Record<string, unknown> | undefined;
    if (!stored || stored.question_hash !== questionHash) return jsonNoStore({ error: "That idempotency key is already associated with another query." }, { status: 409 });
    if (await sha256(String(stored.answer_text)) !== stored.answer_checksum) return jsonNoStore({ error: "The stored archive answer failed its integrity check." }, { status: 503 });
    if (stored.supported === 1 && stored.status === "building") {
      try {
        await env.DB.batch([
          env.DB.prepare("INSERT OR IGNORE INTO legacy_query_sources (household_id,query_receipt_id,segment_id,transcript_id,correction_id,recording_id,rank,score_micros) VALUES (?,?,?,?,?,?,0,?)").bind(householdId, requestId, stored.selected_segment_id, stored.selected_transcript_id, stored.selected_correction_id, stored.selected_recording_id, stored.selected_score_micros),
          env.DB.prepare("UPDATE legacy_query_receipts SET status='ready',completed_at=? WHERE id=? AND household_id=? AND status='building'").bind(Date.now(), requestId, householdId),
        ]);
      } catch { return jsonNoStore({ error: "The cited recording changed before this result was finalized. Please search again.", code: "archive_source_changed" }, { status: 409 }); }
    }
    if (stored.supported !== 1) return jsonNoStore({ answer: stored.answer_text, supported: false, sources: [], label: "No recorded source" });
    const sourceResult = await env.DB.prepare("SELECT q.segment_id AS segmentId,q.transcript_id AS transcriptId,q.correction_id AS correctionId,q.recording_id AS recordingId,s.contributor_id AS contributorId,r.recorded_at AS recordedAt,s.start_ms AS startMs,s.end_ms AS endMs,m.checksum AS checksum,CASE WHEN s.status='ready' AND t.status='ready' AND r.status='ready' AND m.status='ready' AND n.status IN ('active','deceased_pending_review') AND c.status='active' AND tc.status='active' AND (c.expires_at IS NULL OR c.expires_at>?) AND (tc.expires_at IS NULL OR tc.expires_at>?) AND EXISTS (SELECT 1 FROM legacy_consents sc WHERE sc.household_id=s.household_id AND sc.contributor_id=s.contributor_id AND sc.kind='transcription' AND sc.status='active' AND (sc.expires_at IS NULL OR sc.expires_at>?)) AND NOT EXISTS (SELECT 1 FROM legacy_deletion_operations d WHERE d.household_id=q.household_id AND d.status IN ('queued','processing','failed','dead_letter') AND (d.target_kind='archive' OR (d.target_kind='contributor' AND d.target_id=s.contributor_id) OR (d.target_kind='recording' AND d.target_id=r.id))) THEN 1 ELSE 0 END AS playable FROM legacy_query_sources q JOIN legacy_transcript_segments s ON s.id=q.segment_id AND s.household_id=q.household_id JOIN legacy_transcripts t ON t.id=q.transcript_id AND t.household_id=q.household_id JOIN legacy_recordings r ON r.id=q.recording_id AND r.household_id=q.household_id JOIN media_assets m ON m.id=r.media_asset_id AND m.household_id=r.household_id JOIN contributors n ON n.id=s.contributor_id AND n.household_id=s.household_id JOIN legacy_consents c ON c.id=r.consent_id AND c.household_id=r.household_id JOIN legacy_consents tc ON tc.id=t.consent_id AND tc.household_id=t.household_id WHERE q.household_id=? AND q.query_receipt_id=? AND q.rank=0").bind(Date.now(),Date.now(),Date.now(), householdId, requestId).all();
    const source = sourceResult.results?.[0] as Record<string, unknown> | undefined;
    if (!source) return jsonNoStore({ error: "The stored archive citation is unavailable.", code: "archive_source_unavailable" }, { status: 409 });
    const playable = source.playable === 1;
    if (!playable) return jsonNoStore({ answer: LEGACY_NO_EVIDENCE_RESPONSE, supported: false, sources: [], label: "Recorded source currently unavailable" });
    return jsonNoStore({ answer: stored.answer_text, supported: true, sources: [{ ...source, playable: true, recordedAt: new Date(Number(source.recordedAt)).toISOString(), provenance: source.correctionId ? "corrected_transcript" : "original_recording" }], label: source.correctionId ? "Corrected transcript of original recording" : "Original family recording" });
  } catch (error) { return apiV1Failure(error, "The family archive could not be searched."); }
}
