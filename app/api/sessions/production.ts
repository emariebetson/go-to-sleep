import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  deletionReconciliations,
  generationOperations,
  householdStorageReservations,
  mediaAssets,
  sleepSessions,
  task2cMediaIntegrity,
} from "@/db/schema";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { assessChildNarrationSafety, synthesizeAfterChildModeration, type RemoteModerationVerdict } from "@/lib/child-safety";
import { demoNarratorEnabled } from "@/lib/demo-narrator";
import { classifySpeechGenerationError } from "@/lib/elevenlabs";
import { assertTrustedMutationOrigin, fetchWithTimeout, jsonNoStore, readJsonObject } from "@/lib/http";
import {
  parseProductionAudioRequest,
  previewAudioStorageKey,
  productionSessionId,
  sessionAudioStorageKey,
  validateAudioGenerationResult,
  type AudioGenerationResult,
  type ParsedProductionAudioRequest,
} from "@/lib/nearsleep-audio";
import { sha256Hex } from "@/lib/nearsleep-library";
import {
  acquireVoiceConsentLease,
  claimGenerationOperation,
  completeGenerationOperation,
  failGenerationOperation,
  finalizeVoiceConsentLease,
  generationResultStorageKey,
  persistRecoverableGenerationResult,
  recoverGenerationResult,
  requireCurrentAdultOnboarding,
  stageGenerationResult,
  validateConsumedVoiceConsentLease,
  validateVoiceConsentLease,
  type GenerationResultBucket,
} from "@/lib/nearsleep-live";
import { createDurableGenerationPostHandler, GenerationResultInvalidatedError, GenerationResultReconciliationError } from "@/lib/nearsleep-live-route";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled, nearSleepNarratorPolicy, nearSleepProductionEnabled, type PlanId } from "@/lib/nearyou-foundation";
import { loadSelectableChildProfile } from "@/lib/nearsleep-selectors";
import {
  allowanceWeightForNarration,
  classifyReservationFailure,
  finalizeHouseholdAllowance,
  finalizeProviderSpend,
  markProviderSpendChargeCommitted,
  providerSpendEstimateMicrocents,
  recordProviderFailure,
  recordProviderSuccess,
  requireCurrentNearSleepEntitlement,
  reserveHouseholdAllowance,
  reserveProviderSpend,
} from "@/lib/usage-reservations";

type AudioObject = { text(): Promise<string>; arrayBuffer?(): Promise<ArrayBuffer>; customMetadata?: Record<string, string> };
type AudioBucket = GenerationResultBucket & {
  get(key: string): Promise<AudioObject | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  delete(key: string): Promise<void>;
};

type ExecutionState = {
  sessionId?: string;
  audioKey: string;
  leaseId?: string;
  allowanceReservationId?: string;
  providerSpendReservationId?: string;
  mediaAssetId?: string;
  providerInvoked: boolean;
  providerSettled: boolean;
  ready: boolean;
};

const labels: Record<string, string> = { "moonlit-meadow": "Moonlit Meadow", "sleepy-sea": "Sleepy Sea", "cloud-garden": "Cloud Garden" };
// This is an ElevenLabs public catalog voice ID, never a customer clone reference.
const DEFAULT_DEMO_VOICE_ID = "cgSgspJ2msm6clMCkdW9";

function bucket() {
  return (env as unknown as { AUDIO?: AudioBucket }).AUDIO;
}

async function generateSpeech(apiKey: string, providerVoiceId: string, narration: string) {
  return fetchWithTimeout(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(providerVoiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      text: narration,
      model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
      voice_settings: { stability: 0.78, similarity_boost: 0.75, style: 0.12, use_speaker_boost: true },
    }),
  }, 90_000);
}

async function moderateEditedNarration(input: { householdId: string; userId: string; requestId: string; narration: string }): Promise<RemoteModerationVerdict> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "unavailable";
  const estimate = providerSpendEstimateMicrocents("openai", "script", Math.ceil(input.narration.length / 4));
  let spend;
  try {
    spend = await reserveProviderSpend({
      householdId: input.householdId,
      userId: input.userId,
      provider: "openai",
      operation: "nearsleep_edited_narration_moderation",
      idempotencyKey: `audio:${input.requestId}:moderation`,
      estimatedMicrocents: estimate,
    });
  } catch { return "unavailable"; }
  if (spend.reservation.status !== "in_flight") return "unavailable";
  let invoked = false;
  try {
    await markProviderSpendChargeCommitted(spend.reservation.id);
    invoked = true;
    const response = await fetchWithTimeout("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "omni-moderation-latest", input: input.narration }),
    }, 30_000);
    await finalizeProviderSpend(spend.reservation.id, "settled", estimate).catch(() => undefined);
    if (!response.ok) { await recordProviderFailure("openai").catch(() => undefined); return "unavailable"; }
    const payload = await response.json() as { results?: Array<{ flagged?: boolean }> };
    if (typeof payload.results?.[0]?.flagged !== "boolean") { await recordProviderFailure("openai").catch(() => undefined); return "unavailable"; }
    await recordProviderSuccess("openai").catch(() => undefined);
    return payload.results[0].flagged ? "unsafe" : "safe";
  } catch {
    if (invoked) await finalizeProviderSpend(spend.reservation.id, "settled").catch(() => undefined);
    else await finalizeProviderSpend(spend.reservation.id, "released").catch(() => undefined);
    await recordProviderFailure("openai").catch(() => undefined);
    return "unavailable";
  }
}

async function storeResult(input: {
  key: string;
  result: AudioGenerationResult;
  householdId: string;
  userId: string;
  operationId: string;
}) {
  const metadata = { householdId: input.householdId, userId: input.userId, operationId: input.operationId };
  const writes = await Promise.allSettled([
    persistRecoverableGenerationResult(bucket()!, input.key, input.result, metadata),
    stageGenerationResult({ ...metadata, result: input.result }),
  ]);
  if (writes.every((write) => write.status === "rejected")) throw new GenerationResultReconciliationError();
}

async function recordDeletionFailure(scopeId: string, audioKey: string, errorCode: string) {
  const now = new Date();
  await getDb().insert(deletionReconciliations).values({
    id: `cleanup:${crypto.randomUUID()}`,
    scope: "session",
    scopeId,
    status: "cleanup_pending",
    storageKeys: [audioKey],
    providerReferences: [],
    errorCode,
    createdAt: now,
    updatedAt: now,
  });
}

async function deleteOrReconcile(scopeId: string, audioKey: string, errorCode: string) {
  if (!audioKey) return;
  try { await bucket()!.delete(audioKey); } catch (error) {
    console.error("NearSleep audio cleanup requires reconciliation", scopeId, error);
    await recordDeletionFailure(scopeId, audioKey, errorCode);
  }
}

export async function finalizeSavedSession(input: {
  sessionId: string;
  householdId: string;
  userId: string;
  childProfileId: string;
  audioKey: string;
  byteSize: number;
  checksum?: string | null;
  providerRequestId?: string | null;
  onSessionReady?: () => void;
}) {
  const db = getDb();
  const mediaAssetId = `media:${input.sessionId}`;
  const now = new Date();
  await db.insert(mediaAssets).values({
    id: mediaAssetId,
    householdId: input.householdId,
    ownerUserId: input.userId,
    childProfileId: input.childProfileId,
    legacySessionId: input.sessionId,
    kind: "narration",
    status: "processing",
    storageKey: input.audioKey,
    contentType: "audio/mpeg",
    byteSize: input.byteSize,
    checksum: input.checksum || null,
    private: true,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  const media = await db.select({
    id: mediaAssets.id,
    status: mediaAssets.status,
    storageKey: mediaAssets.storageKey,
    childProfileId: mediaAssets.childProfileId,
    legacySessionId: mediaAssets.legacySessionId,
  }).from(mediaAssets).where(and(
    eq(mediaAssets.id, mediaAssetId),
    eq(mediaAssets.householdId, input.householdId),
    eq(mediaAssets.ownerUserId, input.userId),
  )).get();
  if (!media
    || media.storageKey !== input.audioKey
    || media.childProfileId !== input.childProfileId
    || media.legacySessionId !== input.sessionId
    || (media.status !== "processing" && media.status !== "ready")) throw new Error("generation_media_conflict");
  let durableStorageFinalization = nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env));
  if (!durableStorageFinalization) {
    try {
      await db.select({ id: householdStorageReservations.id }).from(householdStorageReservations).limit(1).get();
      durableStorageFinalization = true;
    } catch (error) {
      let detail = "";
      let current: unknown = error;
      for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
        if ("message" in current && typeof current.message === "string") detail += ` ${current.message}`;
        current = "cause" in current ? current.cause : null;
      }
      if (!/no such table: household_storage_reservations/i.test(detail)) throw error;
    }
  }
  if (!durableStorageFinalization) {
    const ready = await db.update(sleepSessions).set({
      status: "ready",
      mediaAssetId,
      audioKey: input.audioKey,
      ...(input.providerRequestId !== undefined ? { providerRequestId: input.providerRequestId } : {}),
      completedAt: now,
    }).where(and(eq(sleepSessions.id, input.sessionId), eq(sleepSessions.householdId, input.householdId), eq(sleepSessions.userId, input.userId), eq(sleepSessions.status, "generating")))
      .returning({ id: sleepSessions.id }).get();
    if (!ready) {
      const existing = await db.select({ status: sleepSessions.status, mediaAssetId: sleepSessions.mediaAssetId, audioKey: sleepSessions.audioKey }).from(sleepSessions).where(and(
        eq(sleepSessions.id, input.sessionId), eq(sleepSessions.householdId, input.householdId), eq(sleepSessions.userId, input.userId),
      )).get();
      if (existing?.status !== "ready" || existing.mediaAssetId !== mediaAssetId || existing.audioKey !== input.audioKey) throw new Error("generation_session_finalize_conflict");
    }
    input.onSessionReady?.();
    const promoted = await db.update(mediaAssets).set({ status: "ready", byteSize: input.byteSize, checksum: input.checksum || null, updatedAt: now }).where(and(
      eq(mediaAssets.id, mediaAssetId), eq(mediaAssets.householdId, input.householdId), eq(mediaAssets.ownerUserId, input.userId), eq(mediaAssets.storageKey, input.audioKey),
    )).returning({ id: mediaAssets.id }).get();
    if (!promoted) throw new GenerationResultReconciliationError();
    return mediaAssetId;
  }
  if (media.status === "processing") {
    try {
      await db.insert(householdStorageReservations).values({
        id: `storage:${mediaAssetId}`,
        householdId: input.householdId,
        mediaAssetId,
        byteSize: input.byteSize,
        status: "reserved",
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      if (detail.includes("storage_limit_reached")) throw jsonNoStore({ error: "This household has reached its private media storage limit.", code: "storage_limit_reached" }, { status: 409 });
      if (detail.includes("storage_reconciliation_required")) throw jsonNoStore({ error: "Household storage needs reconciliation before new audio can be saved.", code: "storage_reconciliation_required" }, { status: 503 });
      throw error;
    }
    const reservation = await db.select({ byteSize: householdStorageReservations.byteSize, status: householdStorageReservations.status })
      .from(householdStorageReservations).where(and(
        eq(householdStorageReservations.mediaAssetId, mediaAssetId),
        eq(householdStorageReservations.householdId, input.householdId),
      )).get();
    if (!reservation || reservation.byteSize !== input.byteSize || (reservation.status !== "reserved" && reservation.status !== "committed")) {
      throw new GenerationResultReconciliationError();
    }
    const session = await db.select({ status: sleepSessions.status, mediaAssetId: sleepSessions.mediaAssetId, audioKey: sleepSessions.audioKey })
      .from(sleepSessions).where(and(eq(sleepSessions.id, input.sessionId), eq(sleepSessions.householdId, input.householdId), eq(sleepSessions.userId, input.userId))).get();
    if (!session) throw new Error("generation_session_missing");
    if (session.status === "generating") {
      await db.batch([
        db.update(sleepSessions).set({
          status: "ready",
          mediaAssetId,
          audioKey: input.audioKey,
          ...(input.providerRequestId !== undefined ? { providerRequestId: input.providerRequestId } : {}),
          completedAt: now,
        }).where(and(eq(sleepSessions.id, input.sessionId), eq(sleepSessions.householdId, input.householdId), eq(sleepSessions.userId, input.userId), eq(sleepSessions.status, "generating"))),
        db.insert(task2cMediaIntegrity).values({ mediaAssetId, byteSize: input.byteSize, checksum: input.checksum!, verifiedAt: now }).onConflictDoNothing(),
        db.update(mediaAssets).set({ status: "ready", byteSize: input.byteSize, checksum: input.checksum || null, updatedAt: now }).where(and(
          eq(mediaAssets.id, mediaAssetId), eq(mediaAssets.householdId, input.householdId), eq(mediaAssets.ownerUserId, input.userId), eq(mediaAssets.storageKey, input.audioKey), eq(mediaAssets.status, "processing"),
        )),
      ]);
    } else if (session.status === "ready" && session.mediaAssetId === mediaAssetId && session.audioKey === input.audioKey) {
      await db.batch([
        db.insert(task2cMediaIntegrity).values({ mediaAssetId, byteSize: input.byteSize, checksum: input.checksum!, verifiedAt: now }).onConflictDoNothing(),
        db.update(mediaAssets).set({ status: "ready", byteSize: input.byteSize, checksum: input.checksum || null, updatedAt: now }).where(and(
          eq(mediaAssets.id, mediaAssetId), eq(mediaAssets.householdId, input.householdId), eq(mediaAssets.status, "processing"),
        )),
      ]);
    } else {
      throw new Error("generation_session_finalize_conflict");
    }
  }
  const finalized = await db.select({ sessionStatus: sleepSessions.status, mediaStatus: mediaAssets.status, integrityByteSize: task2cMediaIntegrity.byteSize, integrityChecksum: task2cMediaIntegrity.checksum })
    .from(sleepSessions).innerJoin(mediaAssets, eq(sleepSessions.mediaAssetId, mediaAssets.id)).leftJoin(task2cMediaIntegrity, eq(task2cMediaIntegrity.mediaAssetId, mediaAssets.id)).where(and(
      eq(sleepSessions.id, input.sessionId), eq(sleepSessions.householdId, input.householdId), eq(mediaAssets.id, mediaAssetId), eq(mediaAssets.householdId, input.householdId),
    )).get();
  if (finalized?.sessionStatus !== "ready" || finalized.mediaStatus !== "ready" || finalized.integrityByteSize !== input.byteSize || finalized.integrityChecksum !== input.checksum) throw new GenerationResultReconciliationError();
  input.onSessionReady?.();
  return mediaAssetId;
}

async function recoverFromDurableAudio(input: {
  operationId: string;
  householdId: string;
  userId: string;
  requestId: string;
}) {
  const deterministicSessionId = await productionSessionId(input.householdId, input.requestId);
  const sessionKey = sessionAudioStorageKey(input.householdId, deterministicSessionId);
  const previewKey = previewAudioStorageKey(input.householdId, input.requestId);
  let audioKey = sessionKey;
  let object = await bucket()!.get(sessionKey);
  if (!object) {
    audioKey = previewKey;
    object = await bucket()!.get(previewKey);
  }
  const metadata = object?.customMetadata;
  if (!metadata
    || metadata.householdId !== input.householdId
    || metadata.userId !== input.userId
    || metadata.operationId !== input.operationId
    || metadata.requestId !== input.requestId
    || !metadata.result) return null;
  let result: AudioGenerationResult;
  try { result = validateAudioGenerationResult(JSON.parse(metadata.result) as Record<string, unknown>); } catch { throw new Error("invalid_generation_audio_metadata"); }

  const sessionId = result.generationMode === "save" ? deterministicSessionId : undefined;

  if (!sessionId) {
    if (metadata.leaseId) {
      const active = await validateVoiceConsentLease(input, metadata.leaseId);
      if (active) await finalizeVoiceConsentLease(input, metadata.leaseId, "consumed");
      if (!await validateConsumedVoiceConsentLease(input, metadata.leaseId, null)) {
        await deleteOrReconcile(input.requestId, audioKey, "preview_consent_invalidated");
        await cleanupFailedExecution(input, {
          audioKey: "",
          leaseId: metadata.leaseId,
          providerInvoked: true,
          providerSettled: false,
          ready: false,
        });
        throw new GenerationResultInvalidatedError({
          status: 409,
          error: "Voice consent changed before the preview could be finalized.",
          code: "generation_consent_invalidated",
        });
      }
    }
    return result;
  }

  const db = getDb();
  const session = await db.select({
    id: sleepSessions.id,
    status: sleepSessions.status,
    audioKey: sleepSessions.audioKey,
    consentLeaseId: sleepSessions.consentLeaseId,
    allowanceReservationId: sleepSessions.allowanceReservationId,
    mediaAssetId: sleepSessions.mediaAssetId,
  }).from(sleepSessions).where(and(
    eq(sleepSessions.id, sessionId),
    eq(sleepSessions.householdId, input.householdId),
    eq(sleepSessions.userId, input.userId),
  )).get();
  if (!session) throw new Error("generation_session_missing");
  const byteSize = Number.parseInt(metadata.byteSize || "", 10);
  const childProfileId = metadata.childProfileId || "";
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || !childProfileId) throw new Error("invalid_generation_audio_metadata");
  if (session.status === "ready" && session.audioKey === audioKey) {
    await finalizeSavedSession({ sessionId, householdId: input.householdId, userId: input.userId, childProfileId, audioKey, byteSize, checksum: metadata.checksum || null });
    return result;
  }
  if (session.status !== "generating") throw new Error("generation_session_invalid");
  if (session.consentLeaseId) {
    const active = await validateVoiceConsentLease(input, session.consentLeaseId);
    if (active) await finalizeVoiceConsentLease(input, session.consentLeaseId, "consumed");
    if (!await validateConsumedVoiceConsentLease(input, session.consentLeaseId, sessionId)) {
      await deleteOrReconcile(sessionId, audioKey, "session_consent_invalidated");
      await cleanupFailedExecution(input, {
        sessionId,
        audioKey: "",
        leaseId: session.consentLeaseId,
        allowanceReservationId: session.allowanceReservationId || undefined,
        mediaAssetId: session.mediaAssetId || `media:${sessionId}`,
        providerInvoked: true,
        providerSettled: false,
        ready: false,
      });
      throw new GenerationResultInvalidatedError({
        status: 409,
        error: "Voice consent changed before the saved audio could be finalized.",
        code: "generation_consent_invalidated",
      });
    }
  }
  await finalizeSavedSession({ sessionId, householdId: input.householdId, userId: input.userId, childProfileId, audioKey, byteSize, checksum: metadata.checksum || null });
  return result;
}

async function cleanupFailedExecution(actor: { householdId: string; userId: string }, state: ExecutionState) {
  if (state.ready) return;
  if (state.audioKey) await deleteOrReconcile(state.sessionId || "preview", state.audioKey, "generation_cleanup_failed");
  if (state.leaseId) await finalizeVoiceConsentLease(actor, state.leaseId, "revoked").catch(() => undefined);
  await finalizeHouseholdAllowance(state.allowanceReservationId, "released").catch(() => undefined);
  if (state.providerSpendReservationId && !state.providerInvoked) {
    await finalizeProviderSpend(state.providerSpendReservationId, "released").catch(() => undefined);
  }
  if (state.sessionId) {
    await getDb().update(sleepSessions).set({ status: "failed", errorCode: "generation_failed" }).where(and(
      eq(sleepSessions.id, state.sessionId),
      eq(sleepSessions.householdId, actor.householdId),
      eq(sleepSessions.userId, actor.userId),
      eq(sleepSessions.status, "generating"),
    )).catch(() => undefined);
  }
  if (state.mediaAssetId) {
    const now = new Date();
    await getDb().update(mediaAssets).set({ status: "deleted", deletedAt: now, updatedAt: now }).where(and(
      eq(mediaAssets.id, state.mediaAssetId),
      eq(mediaAssets.householdId, actor.householdId),
      eq(mediaAssets.ownerUserId, actor.userId),
    )).catch(() => undefined);
  }
}

export const postProductionSession = createDurableGenerationPostHandler<ParsedProductionAudioRequest, AudioGenerationResult>({
  operation: "audio",
  enabled: () => nearSleepProductionEnabled(featureFlagsFromEnv(process.env)),
  authenticate: async (request) => {
    assertTrustedMutationOrigin(request);
    const context = await requireHouseholdContext(request, "job:write");
    return { householdId: context.householdId, userId: context.user.userId };
  },
  requireAdultGate: async (actor) => {
    if (!bucket()) throw jsonNoStore({ error: "Private audio storage is unavailable." }, { status: 503 });
    await requireCurrentAdultOnboarding(actor);
  },
  parse: async (request) => {
    try { return await parseProductionAudioRequest(await readJsonObject(request, 24_000)); } catch (error) {
      if (error instanceof Response) throw error;
      throw jsonNoStore({ error: error instanceof Error ? error.message : "Audio request is invalid." }, { status: 400 });
    }
  },
  identify: (parsed) => ({ requestId: parsed.input.requestId, requestFingerprint: parsed.fingerprint }),
  claim: async ({ operationId, householdId, userId, requestFingerprint }) => {
    return claimGenerationOperation({ operationId, householdId, userId, requestFingerprint, operation: "audio" }).then((claim) =>
      claim.kind === "replay" ? { kind: "replay" as const, result: validateAudioGenerationResult(claim.result) } : claim,
    );
  },
  recover: async ({ operationId, householdId, userId, requestId }) => {
    const persisted = await recoverGenerationResult(
      bucket()!,
      generationResultStorageKey(householdId, "audio", requestId),
      { operationId, householdId, userId },
    );
    if (persisted) return validateAudioGenerationResult(persisted);
    return recoverFromDurableAudio({ operationId, householdId, userId, requestId });
  },
  execute: async ({ operationId, householdId, userId, requestId, requestFingerprint, input: parsed }) => {
    const input = parsed.input;
    const state: ExecutionState = { audioKey: "", providerInvoked: false, providerSettled: false, ready: false };
    try {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) throw jsonNoStore({ error: "ElevenLabs audio generation is unavailable." }, { status: 503 });
      const childProfile = await loadSelectableChildProfile(householdId, parsed.childProfileId);
      if (!childProfile) throw jsonNoStore({ error: "That child profile is unavailable under the household’s current plan." }, { status: 404 });
      if (childProfile.nickname !== input.childName
        || childProfile.ageMonths !== input.ageMonths
        || childProfile.bedtimeChallenge !== input.challenge
        || (childProfile.pronunciation || "") !== input.pronunciation) {
        throw jsonNoStore({ error: "That child profile changed. Refresh it before generating audio.", code: "child_profile_changed" }, { status: 409 });
      }
      if (!assessChildNarrationSafety(parsed.narration).safe) throw jsonNoStore({ error: "The edited narration did not pass child-safety review." }, { status: 400 });

      const entitlement = await requireCurrentNearSleepEntitlement(householdId).catch((error) => {
        const failure = classifyReservationFailure(error);
        throw jsonNoStore({ error: "A current NearSleep household entitlement is required.", code: failure.code }, { status: failure.status });
      });
      const moderationVerdict = await moderateEditedNarration({ householdId, userId, requestId, narration: parsed.narration });
      if (moderationVerdict === "unsafe") throw jsonNoStore({ error: "The edited narration did not pass child-safety review.", code: "edited_narration_unsafe" }, { status: 400 });
      if (moderationVerdict !== "safe") throw jsonNoStore({ error: "Edited narration safety review is temporarily unavailable. No audio was created.", code: "edited_narration_moderation_unavailable" }, { status: 503 });
      let providerVoiceId: string;
      let lease: Awaited<ReturnType<typeof acquireVoiceConsentLease>> | null = null;
      if (input.narrationKind === "demo_narrator") {
        const { standardNarratorAvailable } = nearSleepNarratorPolicy(entitlement.planId as PlanId, demoNarratorEnabled());
        if (!standardNarratorAvailable) throw jsonNoStore({ error: "Standard narration is unavailable for this household plan." }, { status: 403 });
        providerVoiceId = process.env.ELEVENLABS_DEMO_VOICE_ID || DEFAULT_DEMO_VOICE_ID;
      } else {
        providerVoiceId = "";
      }

      if (input.generationMode === "save") {
        state.sessionId = await productionSessionId(householdId, requestId);
        const now = new Date();
        const inserted = await getDb().insert(sleepSessions).values({
          id: state.sessionId,
          userId,
          householdId,
          childId: childProfile.legacyChildId,
          voiceId: input.narrationKind === "parent_clone" ? input.providerVoiceId : null,
          title: input.sourceTitle || labels[input.theme] || "A gentle bedtime",
          script: input.script,
          pronunciation: input.pronunciation,
          frequencyLayers: JSON.stringify(input.frequencies),
          scriptMode: input.scriptMode,
          contentType: input.contentType,
          narrationKind: input.narrationKind,
          sourceUrl: input.sourceUrl || null,
          sourceTitle: input.sourceTitle || null,
          theme: input.theme,
          style: input.style,
          backgroundSound: input.sound,
          durationMinutes: input.durationMinutes,
          status: "generating",
          createdAt: now,
        }).onConflictDoNothing().returning({ id: sleepSessions.id }).get();
        if (!inserted) throw new Error("generation_session_conflict");
      }

      if (input.narrationKind === "parent_clone") {
        lease = await acquireVoiceConsentLease({
          operationId,
          householdId,
          userId,
          voiceId: input.providerVoiceId,
          sessionId: state.sessionId || null,
        });
        state.leaseId = lease.id;
        providerVoiceId = lease.providerVoiceId;
      }

      const weight = allowanceWeightForNarration(entitlement.planId, input.generationMode, input.durationMinutes);
      const allowance = await reserveHouseholdAllowance({
        householdId,
        userId,
        idempotencyKey: `audio:${requestId}:allowance`,
        operation: "nearsleep_audio_generation",
        quantity: 1,
        weightMilliunits: weight,
        requestFingerprint,
        consentLeaseId: state.leaseId || null,
      }).catch((error) => {
        const failure = classifyReservationFailure(error);
        throw jsonNoStore({ error: "NearSleep generation allowance is unavailable.", code: failure.code }, { status: failure.status });
      });
      state.allowanceReservationId = allowance.reservation?.id;

      if (state.sessionId) {
        await getDb().update(sleepSessions).set({
          consentId: lease?.consentId || null,
          consentVersion: lease?.consentVersion || null,
          consentLeaseId: state.leaseId || null,
          allowanceReservationId: state.allowanceReservationId || null,
        }).where(and(eq(sleepSessions.id, state.sessionId), eq(sleepSessions.householdId, householdId), eq(sleepSessions.userId, userId), eq(sleepSessions.status, "generating")));
      }

      const spendEstimate = providerSpendEstimateMicrocents("elevenlabs", "audio", parsed.wordCount);
      const spend = await reserveProviderSpend({
        householdId,
        userId,
        provider: "elevenlabs",
        operation: input.generationMode === "preview" ? "nearsleep_audio_preview" : "nearsleep_audio_generation",
        idempotencyKey: `audio:${requestId}:elevenlabs`,
        estimatedMicrocents: spendEstimate,
      }).catch((error) => {
        const failure = classifyReservationFailure(error);
        throw jsonNoStore({ error: "Audio generation is temporarily unavailable.", code: failure.code }, { status: failure.status });
      });
      state.providerSpendReservationId = spend.reservation.id;
      await getDb().update(generationOperations).set({
        allowanceReservationId: state.allowanceReservationId || null,
        providerSpendReservationId: state.providerSpendReservationId,
        updatedAt: new Date(),
      }).where(and(eq(generationOperations.id, operationId), eq(generationOperations.householdId, householdId), eq(generationOperations.userId, userId), eq(generationOperations.status, "processing")));
      if (spend.reservation.status !== "in_flight") throw new GenerationResultReconciliationError();

      await markProviderSpendChargeCommitted(spend.reservation.id);
      state.providerInvoked = true;
      const response = await synthesizeAfterChildModeration(
        parsed.narration,
        async () => moderationVerdict,
        () => generateSpeech(apiKey, providerVoiceId, parsed.narration),
      );
      if (!response.ok) {
        const detail = await response.text();
        const failure = classifySpeechGenerationError(response.status, detail);
        throw jsonNoStore({ error: failure.message, code: failure.code }, { status: failure.httpStatus });
      }
      const audio = await response.arrayBuffer();
      await finalizeProviderSpend(spend.reservation.id, "settled", spendEstimate).catch((error) => console.error("Audio provider spend settlement failed", error));
      state.providerSettled = true;
      await recordProviderSuccess("elevenlabs").catch((error) => console.error("Audio provider circuit telemetry failed", error));

      state.audioKey = state.sessionId
        ? sessionAudioStorageKey(householdId, state.sessionId)
        : previewAudioStorageKey(householdId, requestId);
      const result: AudioGenerationResult = state.sessionId
        ? { generationMode: "save", sessionId: state.sessionId, audioUrl: `/api/audio/${encodeURIComponent(state.sessionId)}` }
        : { generationMode: "preview", previewId: requestId, audioUrl: `/api/audio-preview/${encodeURIComponent(requestId)}` };
      const checksum = await sha256Hex(new Uint8Array(audio));
      await bucket()!.put(state.audioKey, audio, {
        httpMetadata: { contentType: "audio/mpeg" },
        customMetadata: {
          householdId,
          userId,
          operationId,
          requestId,
          ...(state.leaseId ? { leaseId: state.leaseId } : {}),
          childProfileId: childProfile.id,
          byteSize: String(audio.byteLength),
          checksum,
          result: JSON.stringify(result),
        },
      });

      if (state.leaseId) {
        if (!await validateVoiceConsentLease({ householdId, userId }, state.leaseId)) throw new Error("voice_consent_lease_invalidated");
        await finalizeVoiceConsentLease({ householdId, userId }, state.leaseId, "consumed");
        if (!await validateConsumedVoiceConsentLease({ householdId, userId }, state.leaseId, state.sessionId || null)) throw new Error("voice_consent_lease_invalidated");
      }

      if (state.sessionId) {
        state.mediaAssetId = `media:${state.sessionId}`;
        await finalizeSavedSession({
          sessionId: state.sessionId,
          householdId,
          userId,
          childProfileId: childProfile.id,
          audioKey: state.audioKey,
          byteSize: audio.byteLength,
          checksum,
          providerRequestId: response.headers.get("request-id"),
          onSessionReady: () => { state.ready = true; },
        });
      }
      state.ready = true;
      await storeResult({ key: generationResultStorageKey(householdId, "audio", requestId), result, householdId, userId, operationId });
      return result;
    } catch (error) {
      if (state.providerInvoked && !state.providerSettled) {
        await finalizeProviderSpend(state.providerSpendReservationId, "settled").catch(() => undefined);
        await recordProviderFailure("elevenlabs").catch(() => undefined);
      }
      await cleanupFailedExecution({ householdId, userId }, state);
      throw error;
    }
  },
  stageResult: ({ operationId, householdId, userId, result }) => stageGenerationResult({ operationId, householdId, userId, result }),
  succeed: ({ operationId, householdId, userId, result }) => completeGenerationOperation({ operationId, householdId, userId, result }),
  fail: ({ operationId, householdId, userId, error }) => failGenerationOperation({ operationId, householdId, userId, error }),
  recordReconciliation: ({ operationId, error }) => console.error("Audio generation result requires reconciliation", operationId, error),
});
