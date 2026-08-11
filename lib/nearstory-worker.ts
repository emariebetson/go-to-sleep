import { assessChildNarrationSafety } from "./child-safety";
import { STORY_MAX_CHARACTERS_PER_MINUTE } from "./nearstory";

export class StoryPersistenceUncertainError extends Error {
  constructor() { super("story_persistence_uncertain"); }
}

export type NearStoryWork = { jobId: string; storyId: string; householdId: string; requestedByUserId: string; voiceId: string; providerVoiceId: string; consentLeaseId: string; reservationId: string; soundscape: string; durationMinutes: number; maxDurationSeconds: number; manifest: Record<string, unknown>; effectCacheKey: string; attemptToken?: string; progressStage?: string };
type Work = NearStoryWork;
type Hold = { id: string; operation: string; maxMicrocents: number; providerSpendReservationId?: string };
type Artifact = { mediaAssetId: string; audioUrl: string };

export type NearStoryWorkerDependencies = {
  claimJob(jobId: string): Promise<Work | null>;
  recoverPersisted(work: Work): Promise<Artifact | null>;
  requireConsent(work: Work): Promise<unknown>;
  claimHold(work: Work, operation: "story_writing" | "story_output_moderation" | "story_speech" | "story_sfx"): Promise<Hold>;
  settleHold(hold: Hold, status: "settled" | "released"): Promise<unknown>;
  releaseUnused(work: Work, reason: string): Promise<unknown>;
  writeStory(work: Work, hold: Hold): Promise<unknown>;
  moderateOutput(narration: string, work: Work, hold: Hold): Promise<{ verdict: "safe" | "unsafe" | "unavailable"; model: string; requestId: string }>;
  synthesize(narration: string, work: Work, hold: Hold, ordinal: number): Promise<{ bytes: Uint8Array; model: string; requestId: string }>;
  getCachedEffect(work: Work): Promise<{ bytes: Uint8Array; cached: true; requestId: null } | null>;
  effect(work: Work, hold: Hold): Promise<{ bytes: Uint8Array; cached: boolean; requestId: string | null }>;
  mix(input: { segments: Uint8Array[]; effect: Uint8Array | null; maxDurationSeconds: number }): Promise<{ audio: Uint8Array; segmentDurationsMs: number[] }>;
  persist(work: Work, input: { audio: Uint8Array; segments: Uint8Array[]; segmentDurationsMs: number[]; narrations: string[]; provenance: Record<string, unknown> }): Promise<Artifact>;
  complete(work: Work, result: Artifact): Promise<unknown>;
  fail(work: Work, code: string): Promise<unknown>;
};

type WriterOutput = { segments: Array<{ ordinal: number; narration: string }>; model: string; requestId: string };

export function validateStoryWriterOutput(value: unknown, durationMinutes: number): WriterOutput {
  if (![5, 10, 15].includes(durationMinutes)) throw new Error("Story duration is invalid.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Writer output must be an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["segments", "model", "requestId"].includes(key))) throw new Error("Writer output contains an unsupported field.");
  if (!Array.isArray(record.segments) || record.segments.length !== 5) throw new Error("Writer output must contain exactly five segments.");
  let totalWords = 0;
  let totalCharacters = 0;
  const totalWordLimit = durationMinutes * 100;
  const segmentWordLimit = Math.ceil(totalWordLimit / 5) + 20;
  const segmentCharacterLimit = Math.ceil(durationMinutes * STORY_MAX_CHARACTERS_PER_MINUTE / 5);
  const segments = record.segments.map((raw, expectedOrdinal) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Writer segment must be an object.");
    const segment = raw as Record<string, unknown>;
    if (Object.keys(segment).some((key) => !["ordinal", "narration"].includes(key))) throw new Error("Writer segment contains an unsupported field.");
    if (segment.ordinal !== expectedOrdinal) throw new Error("Writer segment ordinal is invalid.");
    if (typeof segment.narration !== "string" || !segment.narration.trim() || /\p{Cc}/u.test(segment.narration)) throw new Error("Writer segment narration is invalid.");
    const narration = segment.narration.normalize("NFC").trim();
    if (Array.from(narration).length > segmentCharacterLimit) throw new Error("Writer segment exceeds its character limit.");
    const words = narration.split(/\s+/u).length;
    if (words > segmentWordLimit) throw new Error("Writer segment exceeds its word limit.");
    totalWords += words;
    totalCharacters += Array.from(narration).length;
    return { ordinal: expectedOrdinal, narration };
  });
  if (totalWords > totalWordLimit) throw new Error("Writer output exceeds the total word limit.");
  if (totalCharacters > durationMinutes * STORY_MAX_CHARACTERS_PER_MINUTE) throw new Error("Writer output exceeds the total character limit.");
  if (typeof record.model !== "string" || !record.model || record.model.length > 200 || /\p{Cc}/u.test(record.model) || typeof record.requestId !== "string" || !record.requestId || record.requestId.length > 200 || /\p{Cc}/u.test(record.requestId)) throw new Error("Writer provenance is required and bounded.");
  return { segments, model: record.model, requestId: record.requestId };
}

async function fail(deps: NearStoryWorkerDependencies, work: Work, code: string) {
  try {
    await deps.releaseUnused(work, code);
    await deps.fail(work, code);
    return { status: "failed" as const, code };
  } catch {
    return { status: "retryable" as const, code: "story_failure_reconciliation" as const };
  }
}

export function createNearStoryWorker(deps: NearStoryWorkerDependencies) {
  const inactive = (error: unknown) => error instanceof Error && /consent|delet|cancel/i.test(error.message);
  return {
    async run(jobId: string) {
      const work = await deps.claimJob(jobId);
      if (!work) return { status: "busy" as const };
      const recovered = await deps.recoverPersisted(work);
      if (recovered) {
        try {
          await deps.requireConsent(work);
          await deps.complete(work, recovered);
          return { status: "completed" as const, result: recovered, recovered: true as const };
        } catch (error) {
          if (error instanceof Error && /consent|delet|cancel/i.test(error.message)) return fail(deps, work, "story_consent_invalidated");
          return { status: "retryable" as const, code: "story_persistence_uncertain" as const };
        }
      }
      let writer: WriterOutput;
      let writerHold: Hold | null = null;
      try {
        await deps.requireConsent(work);
        writerHold = await deps.claimHold(work, "story_writing");
        writer = validateStoryWriterOutput(await deps.writeStory(work, writerHold), work.durationMinutes);
        await deps.settleHold(writerHold, "settled");
      } catch (error) {
        if (writerHold) await deps.settleHold(writerHold, "settled").catch(() => undefined);
        return fail(deps, work, inactive(error) ? "story_consent_invalidated" : "story_writer_failed");
      }
      const narration = writer.segments.map((segment) => segment.narration).join("\n\n");
      if (writer.segments.some((segment) => !assessChildNarrationSafety(segment.narration).safe)) return fail(deps, work, "story_output_unsafe");
      let moderation: Awaited<ReturnType<typeof deps.moderateOutput>>;
      let moderationHold: Hold | null = null;
      try {
        await deps.requireConsent(work);
        moderationHold = await deps.claimHold(work, "story_output_moderation");
        moderation = await deps.moderateOutput(narration, work, moderationHold);
        await deps.settleHold(moderationHold, "settled");
      } catch (error) {
        if (moderationHold) await deps.settleHold(moderationHold, "settled").catch(() => undefined);
        return fail(deps, work, inactive(error) ? "story_consent_invalidated" : "story_moderation_unavailable");
      }
      if (moderation.verdict === "unsafe") return fail(deps, work, "story_output_unsafe");
      if (moderation.verdict !== "safe") return fail(deps, work, "story_moderation_unavailable");
      const speech: Array<Awaited<ReturnType<typeof deps.synthesize>>> = [];
      let speechHold: Hold | null = null;
      try {
        speechHold = await deps.claimHold(work, "story_speech");
        for (const segment of writer.segments) {
          await deps.requireConsent(work);
          speech.push(await deps.synthesize(segment.narration, work, speechHold, segment.ordinal));
        }
        await deps.settleHold(speechHold, "settled");
      } catch (error) {
        if (speechHold) await deps.settleHold(speechHold, "settled").catch(() => undefined);
        return fail(deps, work, inactive(error) ? "story_consent_invalidated" : "story_speech_failed");
      }
      let effect: Awaited<ReturnType<typeof deps.effect>> | null = null;
      if (work.soundscape !== "none") {
        effect = await deps.getCachedEffect(work);
      }
      if (work.soundscape !== "none" && !effect) {
        let effectHold: Hold | null = null;
        try {
          await deps.requireConsent(work);
          effectHold = await deps.claimHold(work, "story_sfx");
          effect = await deps.effect(work, effectHold);
          await deps.settleHold(effectHold, effect.cached ? "released" : "settled");
        } catch (error) {
          if (effectHold) await deps.settleHold(effectHold, "settled").catch(() => undefined);
          return fail(deps, work, inactive(error) ? "story_consent_invalidated" : "story_effect_failed");
        }
      }
      try { await deps.requireConsent(work); } catch { return fail(deps, work, "story_consent_invalidated"); }
      const segmentBytes = speech.map((item) => item.bytes);
      let mixed: { audio: Uint8Array; segmentDurationsMs: number[] };
      try { mixed = await deps.mix({ segments: segmentBytes, effect: effect?.bytes || null, maxDurationSeconds: work.maxDurationSeconds }); }
      catch { return fail(deps, work, "story_mix_failed"); }
      try {
        const result = await deps.persist(work, { audio: mixed.audio, segments: segmentBytes, segmentDurationsMs: mixed.segmentDurationsMs, narrations: writer.segments.map((segment) => segment.narration), provenance: {
          planVersion: "nearstory-plan-v1", promptVersion: "nearstory-segment-v1",
          writer: { model: writer.model, requestId: writer.requestId },
          moderation: { model: moderation.model, requestId: moderation.requestId, verdict: moderation.verdict },
          speech: speech.map((item, ordinal) => ({ ordinal, model: item.model, requestId: item.requestId })),
          effect: effect ? { cached: effect.cached, requestId: effect.requestId } : null,
        } });
        try { await deps.requireConsent(work); await deps.complete(work, result); }
        catch { return { status: "retryable" as const, code: "story_persistence_uncertain" as const }; }
        return { status: "completed" as const, result, recovered: false as const };
      } catch (error) {
        if (error instanceof StoryPersistenceUncertainError) return { status: "retryable" as const, code: "story_persistence_uncertain" as const };
        return fail(deps, work, "story_persistence_failed");
      }
    },
  };
}
