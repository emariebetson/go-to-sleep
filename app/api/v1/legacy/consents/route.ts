import { env } from "cloudflare:workers";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readLimitedBytes } from "@/lib/http";
import { parseLegacyConsent } from "@/lib/nearlegacy";
import { putPrivateLegacyObject } from "@/lib/nearlegacy-media";
import { enforceLegacyRateLimit, legacyHash, legacyInternalId, legacyUuid } from "@/lib/nearlegacy-route";
import { nearLegacyReady, requireLegacyEntitlement } from "../production";

type Bucket = Parameters<typeof putPrivateLegacyObject>[0];
const bucket = () => (env as unknown as { AUDIO: Bucket }).AUDIO;
async function checksum(bytes: Uint8Array) { const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }

export async function GET(request: Request) {
  try {
    if (!await nearLegacyReady("read")) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 });
    const { householdId, role, user } = await requireHouseholdContext(request, "archive:read"); if (!await requireLegacyEntitlement(householdId, "read")) return jsonNoStore({ error: "NearLegacy is required." }, { status: 403 });
    const result = role === "owner"
      ? await env.DB.prepare("SELECT id,contributor_id,version,kind,audience,purpose,posthumous_use,status,attested_at,expires_at,revoked_at FROM legacy_consents WHERE household_id=? ORDER BY attested_at DESC LIMIT 200").bind(householdId).all()
      : await env.DB.prepare("SELECT c.id,c.contributor_id,c.version,c.kind,c.audience,c.purpose,c.status,c.expires_at FROM legacy_consents c JOIN contributors n ON n.id=c.contributor_id AND n.household_id=c.household_id WHERE c.household_id=? AND n.adult_user_id=? ORDER BY c.attested_at DESC LIMIT 200").bind(householdId, user.userId).all();
    return jsonNoStore({ consents: result.results || [] });
  } catch (error) { return apiV1Failure(error, "Consent history could not be loaded."); }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutationOrigin(request); if (!await nearLegacyReady()) return jsonNoStore({ error: "NearLegacy is not available." }, { status: 404 });
    const { householdId, user } = await requireHouseholdContext(request, "archive:self"); const limited = await enforceLegacyRateLimit(env.DB, householdId, user.userId, "consent_upload", 4, 60_000); if (limited) return limited; if (!await requireLegacyEntitlement(householdId)) return jsonNoStore({ error: "NearLegacy is required." }, { status: 403 });
    const contentType = request.headers.get("content-type") || ""; if (!contentType.toLowerCase().startsWith("multipart/form-data;")) return jsonNoStore({ error: "Consent requires multipart form data." }, { status: 400 });
    const upload = await readLimitedBytes(request, 2_100_000); const form = await new Response(upload, { headers: { "content-type": contentType } }).formData();
    const key = request.headers.get("idempotency-key") || ""; const id = await legacyInternalId("consent", householdId, key); const contributorId = legacyUuid(form.get("contributorId"), "contributorId");
    const kind = String(form.get("kind") || ""); const version = kind === "synthetic" ? "legacy-synthetic-v1" : "legacy-consent-v1"; const purpose = kind === "synthetic" ? "private_archive_narration" : "private_archive";
    if (kind === "synthetic") return jsonNoStore({ error: "Synthetic narration consent remains unavailable until contributor voice verification is connected." }, { status: 403 });
    const consent = parseLegacyConsent({ version, kind, audience: "household", purposes: [purpose], attested: form.get("attested") === "true", posthumousUse: false, expiresAt: form.get("expiresAt") || null });
    const contributor = await env.DB.prepare("SELECT id FROM contributors WHERE id=? AND household_id=? AND adult_user_id=? AND status='active'").bind(contributorId, householdId, user.userId).all();
    if (!contributor.results?.length) return jsonNoStore({ error: "Contributors must attest their own archive consent." }, { status: 403 });
    const challengeId = legacyUuid(form.get("challengeId"), "challengeId");
    const evidence = form.get("evidence"); if (!(evidence instanceof File) || evidence.size < 1 || evidence.size > 2_000_000 || !["audio/webm", "audio/mp4"].includes(evidence.type)) return jsonNoStore({ error: "A short WebM or M4A liveness recording up to 2 MB is required." }, { status: 400 });
    const bytes = new Uint8Array(await evidence.arrayBuffer()); const evidenceChecksum = await checksum(bytes); const extension = evidence.type === "audio/mp4" ? "m4a" : "webm";
    const uploadedKey = `legacy/${householdId}/evidence/${id}.${extension}`;
    const supersedes = form.get("supersedesConsentId") ? legacyUuid(form.get("supersedesConsentId"), "supersedesConsentId") : null;
    const requestHash = await legacyHash(JSON.stringify({ contributorId, version: consent.version, kind: consent.kind, purpose: consent.purposes[0], expiresAt: consent.expiresAt, supersedes, evidenceChecksum, challengeId }));
    const mediaId = await legacyInternalId("consent-evidence-media", householdId, key), probeId = await legacyInternalId("consent-evidence-probe", householdId, key);
    const existing = await env.DB.prepare("SELECT id,contributor_id,version,kind,audience,purpose,status,attested_at,expires_at FROM legacy_consents WHERE id=? AND household_id=?").bind(id, householdId).all();
    if (existing.results?.length) return jsonNoStore({ consent: existing.results[0], duplicate: true });
    let operation = await env.DB.prepare("SELECT request_hash,status,storage_key FROM legacy_upload_operations WHERE id=? AND household_id=?").bind(id, householdId).all();
    if (!operation.results?.length) {
      const challenge = await env.DB.prepare("SELECT id,phrase,phrase_hash FROM legacy_liveness_challenges WHERE id=? AND household_id=? AND contributor_id=? AND user_id=? AND kind=? AND status='issued' AND expires_at>?").bind(challengeId, householdId, contributorId, user.userId, consent.kind, Date.now()).all();
      if (!challenge.results?.length) return jsonNoStore({ error: "A current one-use liveness challenge is required." }, { status: 422 });
      const processorUrl = process.env.NEARYOU_LEGACY_MEDIA_PROCESSOR_URL?.trim(), processorToken = process.env.NEARYOU_LEGACY_MEDIA_PROCESSOR_TOKEN?.trim();
      if (!processorUrl || !processorUrl.startsWith("https://") || !processorToken || processorToken.length < 32) return jsonNoStore({ error: "Consent verification is temporarily unavailable." }, { status: 503 });
      const challengeRow = challenge.results[0] as Record<string, unknown>;
      let processorResponse: Response;
      try { processorResponse = await fetch(processorUrl, { method: "POST", headers: { authorization: `Bearer ${processorToken}`, "content-type": evidence.type, "x-nearyou-household-id": householdId, "x-nearyou-user-id": user.userId, "x-nearyou-contributor-id": contributorId, "x-nearyou-consent-kind": consent.kind, "x-nearyou-challenge-id": challengeId, "x-nearyou-challenge-phrase": String(challengeRow.phrase), "x-content-sha256": evidenceChecksum }, body: bytes, signal: AbortSignal.timeout(20_000) }); } catch { return jsonNoStore({ error: "Consent verification could not be completed. Try again." }, { status: 503 }); }
      if (!processorResponse.ok) return jsonNoStore({ error: "The liveness recording could not be verified." }, { status: 422 });
      const probe = await processorResponse.json().catch(() => null) as Record<string, unknown> | null;
      if (!probe || probe.challengeId !== challengeId || probe.phraseHash !== challengeRow.phrase_hash || probe.checksum !== evidenceChecksum || probe.byteSize !== bytes.byteLength || probe.contentType !== evidence.type || !Number.isSafeInteger(probe.durationMs) || Number(probe.durationMs) < 2_000 || Number(probe.durationMs) > 60_000 || probe.phraseMatched !== true || probe.liveSpeakerVerified !== true || typeof probe.audioFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(probe.audioFingerprint) || typeof probe.processorReceiptId !== "string" || probe.processorReceiptId.length < 8 || probe.processorReceiptId.length > 200) return jsonNoStore({ error: "The recording did not match the one-use phrase and live speaker check." }, { status: 422 });
      const processorReceiptHash = await legacyHash(JSON.stringify({ processorReceiptId: probe.processorReceiptId, audioFingerprint: probe.audioFingerprint, evidenceChecksum, challengeId, phraseHash: challengeRow.phrase_hash, contributorId, userId: user.userId, durationMs: probe.durationMs }));
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO legacy_upload_operations (id,household_id,requested_by_user_id,kind,request_hash,storage_key,checksum,byte_size,status,target_id,created_at,updated_at) VALUES (?,?,?,'consent_evidence',?,?,?,?, 'staged',?,?,?)").bind(id, householdId, user.userId, requestHash, uploadedKey, evidenceChecksum, bytes.byteLength, id, now, now),
        env.DB.prepare("INSERT INTO media_assets (id,household_id,owner_user_id,kind,status,storage_key,content_type,byte_size,checksum,private,created_at,updated_at) VALUES (?,?,?,'evidence','processing',?,?,?,?,1,?,?)").bind(mediaId, householdId, user.userId, uploadedKey, evidence.type, bytes.byteLength, evidenceChecksum, now, now),
        env.DB.prepare("INSERT INTO household_storage_reservations (id,household_id,media_asset_id,byte_size,status,created_at,updated_at) VALUES (?,?,?,?,'reserved',?,?)").bind(`storage:${mediaId}`, householdId, mediaId, bytes.byteLength, now, now),
        env.DB.prepare("INSERT INTO legacy_media_probe_receipts (id,household_id,challenge_id,user_id,contributor_id,kind,consent_kind,checksum,byte_size,content_type,duration_ms,phrase_matched,live_speaker_verified,processor_receipt_hash,status,expires_at,created_at) VALUES (?,?,?,?,?,'consent_evidence',?,?,?,?,?,1,1,?,'verified',?,?)").bind(probeId, householdId, challengeId, user.userId, contributorId, consent.kind, evidenceChecksum, bytes.byteLength, evidence.type, probe.durationMs, processorReceiptHash, now + 10 * 60_000, now),
      ]);
      operation = await env.DB.prepare("SELECT request_hash,status,storage_key FROM legacy_upload_operations WHERE id=? AND household_id=?").bind(id, householdId).all();
    }
    const op = operation.results?.[0] as Record<string, unknown> | undefined; if (!op || op.request_hash !== requestHash) return jsonNoStore({ error: "That idempotency key is already associated with different consent data." }, { status: 409 });
    if (op.status === "cleanup_required" || op.status === "deleted") return jsonNoStore({ error: "This consent upload was safely closed. Retry with a new idempotency key.", code: "upload_closed" }, { status: 409 });
    if (op.status === "staged") {
      try { await putPrivateLegacyObject(bucket(), uploadedKey, bytes, evidence.type, evidenceChecksum); }
      catch (error) { const failed = Date.now(); await env.DB.batch([env.DB.prepare("UPDATE legacy_upload_operations SET status='cleanup_required',updated_at=? WHERE id=? AND household_id=? AND status='staged'").bind(failed, id, householdId), env.DB.prepare("UPDATE media_assets SET status='deleted',deleted_at=?,updated_at=? WHERE id=? AND household_id=? AND status='processing'").bind(failed, failed, mediaId, householdId)]); throw error; }
    }
    const now = Date.now();
    try { await env.DB.batch([
      env.DB.prepare("UPDATE legacy_upload_operations SET status='stored',updated_at=? WHERE id=? AND household_id=? AND status='staged'").bind(now, id, householdId),
      env.DB.prepare("INSERT INTO task2c_media_integrity (media_asset_id,byte_size,checksum,verified_at) VALUES (?,?,?,?)").bind(mediaId, bytes.byteLength, evidenceChecksum, now),
      env.DB.prepare("UPDATE media_assets SET status='ready',updated_at=? WHERE id=? AND household_id=? AND status='processing'").bind(now, mediaId, householdId),
      env.DB.prepare("INSERT INTO legacy_consents (id,household_id,contributor_id,attesting_user_id,supersedes_consent_id,version,kind,audience,purpose,posthumous_use,status,evidence_key,evidence_checksum,evidence_media_asset_id,liveness_challenge_id,media_probe_receipt_id,attested_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,0,'active',?,?,?,?,?,?,?)").bind(id, householdId, contributorId, user.userId, supersedes, consent.version, consent.kind, consent.audience, consent.purposes[0], uploadedKey, evidenceChecksum, mediaId, challengeId, probeId, now, consent.expiresAt ? Date.parse(consent.expiresAt) : null),
      env.DB.prepare("INSERT INTO legacy_evidence_retention (household_id,consent_id,media_asset_id,delete_after,status,updated_at) VALUES (?,?,?,?,'retained',?)").bind(householdId, id, mediaId, now + 30 * 86400000, now),
      env.DB.prepare("UPDATE legacy_upload_operations SET status='committed',updated_at=? WHERE id=? AND household_id=? AND status='stored'").bind(now, id, householdId),
    ]); } catch (error) {
      const committed = await env.DB.prepare("SELECT id FROM legacy_consents WHERE id=? AND household_id=?").bind(id, householdId).all();
      if (!committed.results?.length) await env.DB.prepare("UPDATE legacy_upload_operations SET status='cleanup_required',updated_at=? WHERE id=? AND household_id=? AND status IN ('staged','stored')").bind(Date.now(), id, householdId).run();
      else return jsonNoStore({ consent: committed.results[0], duplicate: true });
      throw error;
    }
    return jsonNoStore({ consent: { id, contributorId, version: consent.version, kind: consent.kind, audience: consent.audience, purpose: consent.purposes[0], status: "active", attestedAt: now } }, { status: 201 });
  } catch (error) {
    // Staged objects remain durably inventoried for retry/reconciliation; never
    // delete a key here because the database commit response may have been lost.
    return apiV1Failure(error, "Archive consent could not be recorded.");
  }
}
