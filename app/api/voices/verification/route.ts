import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { adultOnboardingAcceptances, deletionReconciliations, voiceReplacements, voices, voiceVerificationChallenges } from "@/db/schema";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import {
  ADULT_ONBOARDING_VERSION,
  VERIFIED_VOICE_CONSENT_VERSION,
  VOICE_VERIFICATION_VERSION,
  buildVerifiedConsentEvidence,
  createVoiceChallengePhrase,
  parseVoiceChallengeRequest,
  validateLiveVoiceSample,
  verificationTranscriptContainsPhrase,
  voiceChallengePhraseHash,
} from "@/lib/adult-voice-verification";
import { assertTrustedMutationOrigin, fetchWithTimeout, jsonNoStore, readJsonObject, readLimitedBytes } from "@/lib/http";
import { featureFlagsFromEnv } from "@/lib/nearyou-foundation";
import { loadVoiceCloneEligibility } from "@/lib/nearsleep-selectors";
import {
  classifyReservationFailure,
  executeConservativelyAccountedProviderCall,
  finalizeProviderSpend,
  markProviderSpendChargeCommitted,
  providerSpendEstimateMicrocents,
  recordProviderFailure,
  recordProviderSuccess,
  reserveProviderSpend,
} from "@/lib/usage-reservations";
import { failedProviderCloneCanBeRetired, retireFailedProviderClone } from "@/lib/voice-clone-cleanup";

const ELEVENLABS = "https://api.elevenlabs.io/v1";

async function sha256Bytes(value: ArrayBuffer | Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value).buffer : value instanceof Uint8Array ? new Uint8Array(value).buffer : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function transcribeLivePassage(apiKey: string, sample: File) {
  const model = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
  const form = new FormData();
  form.append("file", sample, sample.name || "live-passage.webm");
  form.append("model", model);
  form.append("response_format", "json");
  const response = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  }, 45_000);
  if (!response.ok) throw jsonNoStore({ error: "Live voice verification is temporarily unavailable." }, { status: 503 });
  const payload = await response.json() as { text?: string };
  return { transcript: String(payload.text || ""), model, requestId: response.headers.get("request-id") || "unavailable" };
}

async function createReplacementVoice(apiKey: string, name: string, sample: File, correlationId: string) {
  const marker = correlationId.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 120);
  const form = new FormData();
  form.append("name", `${name.slice(0, 42)} verified ${marker.slice(-12)}`);
  form.append("description", `Adult-owned voice verified and cloned from a live random-phrase passage. Correlation: ${marker}`);
  form.append("files", sample, sample.name || "live-passage.webm");
  form.append("remove_background_noise", "true");
  const response = await fetchWithTimeout(`${ELEVENLABS}/voices/add`, { method: "POST", headers: { "xi-api-key": apiKey }, body: form }, 90_000);
  const requestId = response.headers.get("request-id") || "unavailable";
  let payload: { voice_id?: string } = {};
  try { payload = JSON.parse(await response.text()) as { voice_id?: string }; } catch {
    throw new ProviderCloneResponseError(requestId);
  }
  if (!response.ok || !payload.voice_id) throw jsonNoStore({ error: "The verified replacement voice could not be created." }, { status: 502 });
  return { providerVoiceId: payload.voice_id, requestId };
}

class ProviderCloneResponseError extends Error {
  constructor(readonly providerRequestId: string) { super("The voice provider returned an unreadable creation response."); }
}

async function deleteProviderVoice(apiKey: string, providerVoiceId: string) {
  const response = await fetchWithTimeout(`${ELEVENLABS}/voices/${encodeURIComponent(providerVoiceId)}`, { method: "DELETE", headers: { "xi-api-key": apiKey } }, 30_000);
  return response.ok || response.status === 404;
}

export async function POST(request: Request) {
  let claimedChallengeId = "";
  let claimedAttempts = 0;
  let transcriptionSpendId = "";
  let cloneSpendId = "";
  let replacementProviderVoiceId = "";
  let replacementId = "";
  let replacementActivated = false;
  try {
    if (!featureFlagsFromEnv(process.env).productionUpgradeFoundation) return jsonNoStore({ error: "The production upgrade foundation is not enabled." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { householdId, user } = await requireHouseholdContext(request, "voice:consent");
    const currentPlanEligibility = await loadVoiceCloneEligibility(householdId);
    if (!currentPlanEligibility.allowed) return jsonNoStore({
      error: "NearSleep Free uses the standard non-cloned narrator. Upgrade before creating or re-verifying a private voice.",
      code: currentPlanEligibility.reason,
      standardNarratorAvailable: true,
    }, { status: 402 });
    const contentType = request.headers.get("content-type") || "";
    if (contentType.toLowerCase().startsWith("multipart/form-data;")) {
      const openAiKey = process.env.OPENAI_API_KEY;
      const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
      if (!openAiKey || !elevenLabsKey) return jsonNoStore({ error: "Live voice verification is not configured." }, { status: 503 });
      let form: FormData;
      try {
        const upload = await readLimitedBytes(request, 10_500_000);
        form = await new Response(upload, { headers: { "content-type": contentType } }).formData();
      } catch (error) {
        if (error instanceof Response) return error;
        return jsonNoStore({ error: "Live verification form data is invalid." }, { status: 400 });
      }
      const challengeId = String(form.get("challengeId") || "").trim().toLowerCase();
      const phrase = String(form.get("phrase") || "");
      let sample: File;
      try { sample = validateLiveVoiceSample(form.get("sample")); } catch (error) {
        return jsonNoStore({ error: error instanceof Error ? error.message : "The live recording is invalid." }, { status: 400 });
      }
      const db = getDb();
      const challenge = await db.select({
        id: voiceVerificationChallenges.id,
        voiceId: voiceVerificationChallenges.voiceId,
        version: voiceVerificationChallenges.version,
        phrase: voiceVerificationChallenges.phrase,
        phraseHash: voiceVerificationChallenges.phraseHash,
      }).from(voiceVerificationChallenges).where(and(
        eq(voiceVerificationChallenges.id, challengeId),
        eq(voiceVerificationChallenges.householdId, householdId),
        eq(voiceVerificationChallenges.adultUserId, user.userId),
        eq(voiceVerificationChallenges.status, "pending"),
        gt(voiceVerificationChallenges.expiresAt, new Date()),
        lt(voiceVerificationChallenges.attempts, 3),
      )).get();
      if (!challenge) return jsonNoStore({ error: "That live phrase challenge is invalid or expired. Start a new one." }, { status: 409 });
      if (challenge.version !== VOICE_VERIFICATION_VERSION || challenge.phraseHash !== await voiceChallengePhraseHash(challenge.id, phrase)) {
        return jsonNoStore({ error: "The live phrase does not match this challenge." }, { status: 400 });
      }
      const claimed = await db.update(voiceVerificationChallenges).set({ status: "processing", attempts: sql`${voiceVerificationChallenges.attempts} + 1` }).where(and(
        eq(voiceVerificationChallenges.id, challenge.id),
        eq(voiceVerificationChallenges.status, "pending"),
        lt(voiceVerificationChallenges.attempts, 3),
        gt(voiceVerificationChallenges.expiresAt, new Date()),
      )).returning({ attempts: voiceVerificationChallenges.attempts }).get();
      if (!claimed) return jsonNoStore({ error: "That live phrase challenge is already being completed." }, { status: 409 });
      claimedChallengeId = challenge.id;
      claimedAttempts = claimed.attempts;

      const ownedVoice = await db.select({ id: voices.id, name: voices.name, providerVoiceId: voices.providerVoiceId, currentConsentId: voices.currentConsentId }).from(voices).where(and(
        eq(voices.id, challenge.voiceId), eq(voices.householdId, householdId), eq(voices.userId, user.userId), inArray(voices.status, ["processing", "ready"]),
      )).get();
      if (!ownedVoice?.currentConsentId) throw jsonNoStore({ error: "Voice profile not found." }, { status: 404 });
      const claimedEligibility = await loadVoiceCloneEligibility(householdId, ownedVoice.id);
      if (!claimedEligibility.allowed) throw jsonNoStore({
        error: "This voice is unavailable under the household’s current plan. No recording was sent to a provider.",
        code: claimedEligibility.reason,
      }, { status: 402 });
      replacementId = `voice-replacement:${challenge.id}`;
      try {
        await db.insert(voiceReplacements).values({
          id: replacementId,
          householdId,
          voiceId: ownedVoice.id,
          challengeId: challenge.id,
          adultUserId: user.userId,
          originalProviderVoiceId: ownedVoice.providerVoiceId,
          originalConsentId: ownedVoice.currentConsentId,
          consentId: `verified-consent:${challenge.voiceId}:${challenge.id}:${VERIFIED_VOICE_CONSENT_VERSION}`,
          consentVersion: VERIFIED_VOICE_CONSENT_VERSION,
          status: "processing",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        claimedAttempts = 3;
      } catch {
        throw jsonNoStore({ error: "That voice already has a verification or cleanup in progress." }, { status: 409 });
      }
      try {
        const spend = await reserveProviderSpend({
          householdId, userId: user.userId, provider: "openai", operation: "voice_verification_transcription",
          idempotencyKey: `voice-verify:${challenge.id}:transcription`,
          estimatedMicrocents: providerSpendEstimateMicrocents("openai", "transcription", Math.ceil(sample.size / 1_000)),
        });
        if (spend.reservation.status !== "in_flight") throw new Error("idempotency_conflict");
        transcriptionSpendId = spend.reservation.id;
      } catch (error) {
        const failure = classifyReservationFailure(error);
        throw jsonNoStore({ error: "Live voice verification is temporarily at capacity.", code: failure.code }, { status: failure.status });
      }
      const transcriptionReservationId = transcriptionSpendId;
      const transcription = await executeConservativelyAccountedProviderCall({
        commitBeforeInvoke: async () => {
          await markProviderSpendChargeCommitted(transcriptionSpendId);
          transcriptionSpendId = "";
        },
        invoke: () => transcribeLivePassage(openAiKey, sample),
        settleAfterInvoke: () => finalizeProviderSpend(transcriptionReservationId, "settled"),
        recordSuccess: () => recordProviderSuccess("openai"),
        recordFailure: () => recordProviderFailure("openai"),
      });
      claimedAttempts = 3;
      if (!verificationTranscriptContainsPhrase(transcription.transcript, challenge.phrase)) {
        await db.update(voiceReplacements).set({ status: "failed", errorCode: "phrase_mismatch", updatedAt: new Date() }).where(and(eq(voiceReplacements.id, replacementId), eq(voiceReplacements.status, "processing")));
        await db.update(voiceVerificationChallenges).set({ status: "failed", phrase: "" }).where(and(eq(voiceVerificationChallenges.id, challenge.id), eq(voiceVerificationChallenges.status, "processing")));
        claimedChallengeId = "";
        replacementId = "";
        return jsonNoStore({ error: "The recording did not include the exact live phrase. Start a new challenge and record the full passage again." }, { status: 400 });
      }

      try {
        const spend = await reserveProviderSpend({
          householdId, userId: user.userId, provider: "elevenlabs", operation: "voice_verification_clone",
          idempotencyKey: `voice-verify:${challenge.id}:clone`,
          estimatedMicrocents: providerSpendEstimateMicrocents("elevenlabs", "voice_clone", Math.ceil(sample.size / 1_000)),
        });
        if (spend.reservation.status !== "in_flight") throw new Error("idempotency_conflict");
        cloneSpendId = spend.reservation.id;
      } catch (error) {
        const failure = classifyReservationFailure(error);
        throw jsonNoStore({ error: "Verified voice creation is temporarily at capacity.", code: failure.code }, { status: failure.status });
      }
      const cloneReservationId = cloneSpendId;
      try {
        const replacement = await executeConservativelyAccountedProviderCall({
          commitBeforeInvoke: async () => {
            await markProviderSpendChargeCommitted(cloneSpendId);
            cloneSpendId = "";
          },
          invoke: () => createReplacementVoice(elevenLabsKey, ownedVoice.name, sample, replacementId),
          settleAfterInvoke: () => finalizeProviderSpend(cloneReservationId, "settled"),
          recordSuccess: () => recordProviderSuccess("elevenlabs"),
          recordFailure: () => recordProviderFailure("elevenlabs"),
        });
        replacementProviderVoiceId = replacement.providerVoiceId;
      } catch (error) {
        if (error instanceof ProviderCloneResponseError) {
          await db.update(voiceReplacements).set({ providerRequestId: error.providerRequestId, errorCode: "provider_response_unreadable", updatedAt: new Date() }).where(eq(voiceReplacements.id, replacementId));
        }
        throw error;
      }
      const audioBuffer = await sample.arrayBuffer();
      const verifiedAt = new Date();
      const evidence = await buildVerifiedConsentEvidence({
        challengeId: challenge.id,
        challengeVersion: challenge.version,
        phraseHash: challenge.phraseHash,
        audioSha256: await sha256Bytes(audioBuffer),
        transcriptSha256: await sha256Bytes(transcription.transcript),
        transcriptionModel: transcription.model,
        transcriptionRequestId: transcription.requestId,
        previousProviderVoiceId: ownedVoice.providerVoiceId,
        replacementProviderVoiceId,
      });
      const providerCreated = await db.update(voiceReplacements).set({
          replacementProviderVoiceId,
          evidence,
          status: "provider_created",
          updatedAt: verifiedAt,
      }).where(and(eq(voiceReplacements.id, replacementId), eq(voiceReplacements.status, "processing"))).returning({ id: voiceReplacements.id }).get();
      if (!providerCreated) throw new Error("voice_replacement_claim_lost");
      const activated = await db.update(voiceReplacements).set({ status: "activating", updatedAt: verifiedAt }).where(and(
          eq(voiceReplacements.id, replacementId),
          eq(voiceReplacements.status, "provider_created"),
          sql`EXISTS (SELECT 1 FROM voices WHERE voices.id = ${voiceReplacements.voiceId} AND voices.status IN ('processing','ready') AND voices.provider_voice_id = ${voiceReplacements.originalProviderVoiceId} AND voices.current_consent_id = ${voiceReplacements.originalConsentId})`,
      )).returning({ id: voiceReplacements.id }).get();
      if (!activated) throw new Error("voice_activation_cas_failed");
      replacementActivated = true;
      const activation = await db.select({ status: voiceReplacements.status }).from(voiceReplacements).where(eq(voiceReplacements.id, replacementId)).get();
      if (activation?.status !== "cleanup_pending") throw new Error("voice_activation_incomplete");
      claimedChallengeId = "";
      replacementProviderVoiceId = "";
      let retired = ownedVoice.providerVoiceId.startsWith("pending:");
      if (!retired) {
        try { retired = await deleteProviderVoice(elevenLabsKey, ownedVoice.providerVoiceId); } catch { /* durable cleanup_pending state is reconciled later */ }
      }
      if (retired) {
        await db.update(voiceReplacements).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() }).where(and(eq(voiceReplacements.id, replacementId), eq(voiceReplacements.status, "cleanup_pending")));
      }
      return jsonNoStore({ verified: true, consentVersion: VERIFIED_VOICE_CONSENT_VERSION, cleanupPending: !retired });
    }

    let input;
    try { input = parseVoiceChallengeRequest(await readJsonObject(request, 4_000)); } catch (error) {
      if (error instanceof Response) return error;
      return jsonNoStore({ error: error instanceof Error ? error.message : "Challenge request is invalid." }, { status: 400 });
    }
    const db = getDb();
    const [onboarding, voice] = await Promise.all([
      db.select({ id: adultOnboardingAcceptances.id }).from(adultOnboardingAcceptances).where(and(
        eq(adultOnboardingAcceptances.householdId, householdId), eq(adultOnboardingAcceptances.adultUserId, user.userId), eq(adultOnboardingAcceptances.version, ADULT_ONBOARDING_VERSION),
      )).get(),
      db.select({ id: voices.id }).from(voices).where(and(
        eq(voices.id, input.voiceId), eq(voices.householdId, householdId), eq(voices.userId, user.userId), inArray(voices.status, ["processing", "ready"]),
      )).get(),
    ]);
    if (!onboarding) return jsonNoStore({ error: "Complete the current adult caregiver onboarding before verifying a voice." }, { status: 403 });
    if (!voice) return jsonNoStore({ error: "Voice profile not found." }, { status: 404 });
    const challengeEligibility = await loadVoiceCloneEligibility(householdId, voice.id);
    if (!challengeEligibility.allowed) return jsonNoStore({
      error: "This voice is unavailable under the household’s current plan.",
      code: challengeEligibility.reason,
    }, { status: 402 });
    const generated = createVoiceChallengePhrase();
    const now = new Date();
    const inserted = await db.insert(voiceVerificationChallenges).values({
      id: input.requestId, householdId, voiceId: voice.id, adultUserId: user.userId, onboardingAcceptanceId: onboarding.id,
      version: generated.version, phrase: generated.phrase, phraseHash: await voiceChallengePhraseHash(input.requestId, generated.phrase),
      status: "pending", expiresAt: new Date(now.getTime() + 5 * 60_000), createdAt: now,
    }).onConflictDoNothing().returning({ id: voiceVerificationChallenges.id }).get();
    const challenge = await db.select({ voiceId: voiceVerificationChallenges.voiceId, version: voiceVerificationChallenges.version, phrase: voiceVerificationChallenges.phrase, status: voiceVerificationChallenges.status, expiresAt: voiceVerificationChallenges.expiresAt }).from(voiceVerificationChallenges).where(and(
      eq(voiceVerificationChallenges.id, input.requestId), eq(voiceVerificationChallenges.householdId, householdId), eq(voiceVerificationChallenges.adultUserId, user.userId),
    )).get();
    if (!challenge || challenge.voiceId !== voice.id || challenge.version !== VOICE_VERIFICATION_VERSION || challenge.status !== "pending" || challenge.expiresAt.getTime() <= Date.now()) {
      if (challenge?.status === "pending" && challenge.expiresAt.getTime() <= Date.now()) await db.update(voiceVerificationChallenges).set({ status: "expired", phrase: "" }).where(eq(voiceVerificationChallenges.id, input.requestId));
      return jsonNoStore({ error: "That request ID is already associated with unavailable verification data. Start with a new request ID." }, { status: 409 });
    }
    return jsonNoStore({ challengeId: input.requestId, version: challenge.version, phrase: challenge.phrase, expiresAt: challenge.expiresAt, duplicate: !inserted }, { status: inserted ? 201 : 200 });
  } catch (error) {
    if (transcriptionSpendId) await finalizeProviderSpend(transcriptionSpendId, "released").catch(() => undefined);
    if (cloneSpendId) await finalizeProviderSpend(cloneSpendId, "released").catch(() => undefined);
    let replacementCanBeRetired = false;
    if (replacementProviderVoiceId && replacementId && !replacementActivated) {
      try {
        const [replacementState, voiceState] = await Promise.all([
          getDb().select({ status: voiceReplacements.status }).from(voiceReplacements).where(eq(voiceReplacements.id, replacementId)).get(),
          getDb().select({ providerVoiceId: voices.providerVoiceId }).from(voices)
            .innerJoin(voiceReplacements, eq(voices.id, voiceReplacements.voiceId))
            .where(eq(voiceReplacements.id, replacementId)).get(),
        ]);
        replacementCanBeRetired = failedProviderCloneCanBeRetired({
          replacementActivated,
          replacementProviderVoiceId,
          currentVoiceProviderVoiceId: voiceState?.providerVoiceId,
          replacementStatus: replacementState?.status,
        });
      } catch { /* ambiguous activation state must never delete a possibly-current clone */ }
    }
    if (replacementCanBeRetired && replacementProviderVoiceId && process.env.ELEVENLABS_API_KEY) {
      const providerVoiceId = replacementProviderVoiceId;
      const cleanupId = `voice-replacement-delete:${replacementId || claimedChallengeId}`;
      const cleanup = await retireFailedProviderClone({
        providerVoiceId,
        deleteProviderVoice: (id) => deleteProviderVoice(process.env.ELEVENLABS_API_KEY!, id),
        persistCleanup: async (id) => {
          const now = new Date();
          await getDb().batch([
            getDb().update(voiceReplacements).set({ replacementProviderVoiceId: id, errorCode: "activation_cleanup_pending", updatedAt: now }).where(eq(voiceReplacements.id, replacementId)),
            getDb().insert(deletionReconciliations).values({
              id: cleanupId,
              scope: "voice",
              scopeId: replacementId || claimedChallengeId,
              status: "cleanup_pending",
              storageKeys: [],
              providerReferences: [id],
              errorCode: "voice_replacement_activation_failed",
              createdAt: now,
              updatedAt: now,
            }).onConflictDoNothing(),
          ]);
        },
      }).catch(() => ({ cleanupPending: true as const }));
      if (!cleanup.cleanupPending) replacementProviderVoiceId = "";
    }
    if (replacementId && !replacementActivated) {
      try { await getDb().update(voiceReplacements).set({ status: "failed", errorCode: sql`COALESCE(${voiceReplacements.errorCode}, 'verification_failed')`, updatedAt: new Date() }).where(and(eq(voiceReplacements.id, replacementId), sql`${voiceReplacements.status} IN ('processing','provider_created','activating')`)); } catch { /* challenge remains fail-closed below */ }
    }
    if (claimedChallengeId && !replacementActivated) {
      try { await getDb().update(voiceVerificationChallenges).set({ status: claimedAttempts >= 3 ? "failed" : "pending" }).where(and(eq(voiceVerificationChallenges.id, claimedChallengeId), eq(voiceVerificationChallenges.status, "processing"))); } catch { /* durable processing state blocks duplicate provider work */ }
    }
    if (error instanceof Response) return error;
    console.error("Voice verification failed", error);
    return jsonNoStore({ error: "Voice verification could not be completed." }, { status: 500 });
  }
}
