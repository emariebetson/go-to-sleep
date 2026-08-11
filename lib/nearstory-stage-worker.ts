import { env } from "cloudflare:workers";
import { and, eq, gt, inArray, lte, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { jobs, providerSpendReservations, storyExperiences, storyPersistStagingObjects, storyProviderBudgetHolds, storyWorkerCheckpoints, usageReservations, voiceConsentLeases } from "@/db/schema";
import { createNearStoryProductionDependencies, nextDispatchableNearStoryJobId } from "./nearstory-production-worker";
import { validateStoryWriterOutput, type NearStoryWork } from "./nearstory-worker";
import { sha256Hex } from "./nearsleep-library";

type StageBucket = { put(key: string, body: Uint8Array, options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }): Promise<unknown>; get(key: string): Promise<{ size: number; customMetadata?: Record<string, string>; arrayBuffer(): Promise<ArrayBuffer> } | null>; head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>; delete(key: string): Promise<void> };
type CheckpointStage = "writer" | "moderation" | "speech" | "effect" | "mix";

function bucket() { return (env as unknown as { AUDIO?: StageBucket }).AUDIO; }

async function checkpoint(storyId: string, stage: CheckpointStage, ordinal = -1) {
  return getDb().select().from(storyWorkerCheckpoints).where(and(eq(storyWorkerCheckpoints.storyId, storyId), eq(storyWorkerCheckpoints.stage, stage), eq(storyWorkerCheckpoints.ordinal, ordinal), eq(storyWorkerCheckpoints.status, "ready"))).get();
}

async function anyCheckpoint(storyId: string, stage: CheckpointStage, ordinal = -1) { return getDb().select().from(storyWorkerCheckpoints).where(and(eq(storyWorkerCheckpoints.storyId, storyId), eq(storyWorkerCheckpoints.stage, stage), eq(storyWorkerCheckpoints.ordinal, ordinal))).get(); }

async function writeJsonCheckpoint(work: NearStoryWork, stage: "writer" | "moderation", payload: Record<string, unknown>) {
  await assertCheckpointWriteAllowed(work);
  const now = new Date();
  await getDb().insert(storyWorkerCheckpoints).values({ id: `${work.storyId}:checkpoint:${stage}`, householdId: work.householdId, storyId: work.storyId, attemptToken: work.attemptToken || "", stage, ordinal: -1, payload, status: "ready", createdAt: now, updatedAt: now }).onConflictDoNothing();
  return checkpoint(work.storyId, stage);
}

async function writeAudioCheckpoint(work: NearStoryWork, stage: "speech" | "effect" | "mix", ordinal: number, bytes: Uint8Array, payload: Record<string, unknown>) {
  const storage = bucket(); if (!storage || !bytes.length || bytes.length > 75_000_000) throw new Error("story_checkpoint_storage_invalid");
  await assertCheckpointWriteAllowed(work);
  const checksum = await sha256Hex(bytes); const suffix = ordinal < 0 ? stage : `${stage}-${ordinal}`; const attemptToken = work.attemptToken || "";
  const key = `households/${encodeURIComponent(work.householdId)}/stories/${encodeURIComponent(work.storyId)}/checkpoints/${suffix}-${encodeURIComponent(attemptToken)}.mp3`; const now = new Date();
  const existing = await anyCheckpoint(work.storyId, stage, ordinal);
  if (existing?.status === "ready") return existing;
  if (existing && existing.attemptToken !== attemptToken) {
    if (existing.storageKey) { await storage.delete(existing.storageKey).catch(() => undefined); if (await storage.head(existing.storageKey)) throw new Error("story_checkpoint_stale_cleanup_retry"); }
    await getDb().update(storyWorkerCheckpoints).set({ attemptToken, payload, storageKey: key, byteSize: bytes.length, checksum, status: "staging", updatedAt: now }).where(and(eq(storyWorkerCheckpoints.id, existing.id), eq(storyWorkerCheckpoints.attemptToken, existing.attemptToken), eq(storyWorkerCheckpoints.status, "staging")));
  } else if (!existing) await getDb().insert(storyWorkerCheckpoints).values({ id: `${work.storyId}:checkpoint:${suffix}`, householdId: work.householdId, storyId: work.storyId, attemptToken, stage, ordinal, payload, storageKey: key, byteSize: bytes.length, checksum, status: "staging", createdAt: now, updatedAt: now });
  try {
    await storage.put(key, bytes, { httpMetadata: { contentType: "audio/mpeg" }, customMetadata: { checksum, householdId: work.householdId, storyId: work.storyId, stage, attemptToken } });
    await assertCheckpointWriteAllowed(work); const head = await storage.head(key); if (!head || head.size !== bytes.length || head.customMetadata?.checksum !== checksum) throw new Error("story_checkpoint_storage_uncertain");
    const ready = await getDb().update(storyWorkerCheckpoints).set({ status: "ready", updatedAt: new Date() }).where(and(eq(storyWorkerCheckpoints.storyId, work.storyId), eq(storyWorkerCheckpoints.stage, stage), eq(storyWorkerCheckpoints.ordinal, ordinal), eq(storyWorkerCheckpoints.attemptToken, attemptToken), eq(storyWorkerCheckpoints.status, "staging"))).returning({ id: storyWorkerCheckpoints.id }).get(); if (!ready) throw new Error("story_checkpoint_attempt_lost");
  } catch (error) { await storage.delete(key).catch(() => undefined); throw error; }
  return checkpoint(work.storyId, stage, ordinal);
}

async function assertCheckpointWriteAllowed(work: NearStoryWork) {
  const row = await getDb().select({ id: jobs.id }).from(jobs).innerJoin(storyExperiences, and(eq(storyExperiences.jobId, jobs.id), eq(storyExperiences.householdId, jobs.householdId))).innerJoin(voiceConsentLeases, and(eq(voiceConsentLeases.id, storyExperiences.consentLeaseId), eq(voiceConsentLeases.householdId, storyExperiences.householdId))).where(and(eq(jobs.id, work.jobId), eq(jobs.householdId, work.householdId), eq(jobs.status, "running"), eq(jobs.workerAttemptToken, work.attemptToken || ""), eq(storyExperiences.id, work.storyId), inArray(storyExperiences.status, ["queued", "processing"]), eq(voiceConsentLeases.status, "active"), gt(voiceConsentLeases.expiresAt, new Date()))).get();
  if (!row) throw new Error("story_worker_lease_or_consent_lost");
}

async function readCheckpointAudio(record: Awaited<ReturnType<typeof checkpoint>>) {
  const storage = bucket(); if (!storage || !record?.storageKey || !record.byteSize || !record.checksum) throw new Error("story_checkpoint_missing");
  const object = await storage.get(record.storageKey); if (!object || object.size !== record.byteSize || object.customMetadata?.checksum !== record.checksum) throw new Error("story_checkpoint_integrity_failed");
  const bytes = new Uint8Array(await object.arrayBuffer()); if (bytes.length !== record.byteSize) throw new Error("story_checkpoint_integrity_failed"); return bytes;
}

async function requeue(work: NearStoryWork, stage: string, percent: number) {
  const changed = await getDb().update(jobs).set({ status: "queued", progressStage: stage, progressPercent: percent, workerAttemptToken: null, workerLeaseExpiresAt: null, updatedAt: new Date() }).where(and(eq(jobs.id, work.jobId), eq(jobs.householdId, work.householdId), eq(jobs.status, "running"), eq(jobs.workerAttemptToken, work.attemptToken || ""))).returning({ id: jobs.id }).get();
  if (!changed) throw new Error("story_worker_lease_lost");
}

async function settleRecoveredHold(work: NearStoryWork, operation: "story_writing" | "story_output_moderation" | "story_speech" | "story_sfx", deps: ReturnType<typeof createNearStoryProductionDependencies>) {
  const hold = await getDb().select().from(storyProviderBudgetHolds).where(and(eq(storyProviderBudgetHolds.householdId, work.householdId), eq(storyProviderBudgetHolds.storyId, work.storyId), eq(storyProviderBudgetHolds.branchKey, "root"), eq(storyProviderBudgetHolds.operation, operation), eq(storyProviderBudgetHolds.status, "claimed"))).get();
  if (hold?.providerSpendReservationId) await deps.settleHold({ id: hold.id, operation, maxMicrocents: hold.maxMicrocents, providerSpendReservationId: hold.providerSpendReservationId }, "settled");
}

async function failOwned(work: NearStoryWork, code: string, deps: ReturnType<typeof createNearStoryProductionDependencies>) {
  try { await deps.releaseUnused(work, code); await deps.fail(work, code); } catch { return { status: "retryable" as const, code: "story_failure_reconciliation" }; }
  return { status: "failed" as const, code };
}

export async function advanceNextNearStoryStage(jobId?: string) {
  const selected = jobId || await nextDispatchableNearStoryJobId(); if (!selected) return { status: "idle" as const };
  const deps = createNearStoryProductionDependencies(); const work = await deps.claimJob(selected); if (!work) return { status: "busy" as const };
  try {
    await deps.requireConsent(work);
    const stage = work.progressStage || "writing";
    if (stage === "writing") {
      let record = await checkpoint(work.storyId, "writer");
      if (!record) { const hold = await deps.claimHold(work, "story_writing"); const output = validateStoryWriterOutput(await deps.writeStory(work, hold), work.durationMinutes); record = await writeJsonCheckpoint(work, "writer", output as unknown as Record<string, unknown>); await deps.settleHold(hold, "settled"); } else await settleRecoveredHold(work, "story_writing", deps);
      if (!record) throw new Error("story_writer_checkpoint_uncertain"); await requeue(work, "moderating", 15); return { status: "advanced" as const, stage: "writer" };
    }
    const writerRecord = await checkpoint(work.storyId, "writer"); const writer = validateStoryWriterOutput(writerRecord?.payload, work.durationMinutes);
    if (stage === "moderating") {
      let record = await checkpoint(work.storyId, "moderation");
      if (!record) { const hold = await deps.claimHold(work, "story_output_moderation"); const result = await deps.moderateOutput(writer.segments.map((item) => item.narration).join("\n\n"), work, hold); record = await writeJsonCheckpoint(work, "moderation", result); await deps.settleHold(hold, "settled"); } else await settleRecoveredHold(work, "story_output_moderation", deps);
      const verdict = String((record?.payload as { verdict?: unknown })?.verdict || "unavailable"); if (verdict !== "safe") return failOwned(work, verdict === "unsafe" ? "story_output_unsafe" : "story_moderation_unavailable", deps);
      await requeue(work, "speech:0", 25); return { status: "advanced" as const, stage: "moderation" };
    }
    if (stage.startsWith("speech:")) {
      const ordinal = Number(stage.slice(7)); if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 4) throw new Error("story_stage_invalid");
      let record = await checkpoint(work.storyId, "speech", ordinal); const hold = await deps.claimHold(work, "story_speech");
      if (!record) { const speech = await deps.synthesize(writer.segments[ordinal].narration, work, hold, ordinal); record = await writeAudioCheckpoint(work, "speech", ordinal, speech.bytes, { model: speech.model, requestId: speech.requestId }); }
      if (!record) throw new Error("story_speech_checkpoint_uncertain"); if (ordinal === 4) await deps.settleHold(hold, "settled");
      await requeue(work, ordinal === 4 ? "effect" : `speech:${ordinal + 1}`, 35 + ordinal * 8); return { status: "advanced" as const, stage: `speech:${ordinal}` };
    }
    if (stage === "effect") {
      if (work.soundscape !== "none" && !await checkpoint(work.storyId, "effect")) {
        let effect: Awaited<ReturnType<typeof deps.effect>> | Awaited<ReturnType<typeof deps.getCachedEffect>> = await deps.getCachedEffect(work); let hold: Awaited<ReturnType<typeof deps.claimHold>> | null = null;
        if (!effect) { hold = await deps.claimHold(work, "story_sfx"); effect = await deps.effect(work, hold); }
        if (!effect) throw new Error("story_effect_unavailable");
        await writeAudioCheckpoint(work, "effect", -1, effect.bytes, { cached: effect.cached, requestId: effect.requestId });
        if (hold) await deps.settleHold(hold, effect.cached ? "released" : "settled"); else await settleRecoveredHold(work, "story_sfx", deps);
      } else if (work.soundscape !== "none") await settleRecoveredHold(work, "story_sfx", deps);
      await requeue(work, "mix", 80); return { status: "advanced" as const, stage: "effect" };
    }
    if (stage === "mix") {
      let record = await checkpoint(work.storyId, "mix");
      if (!record) { const segments = await Promise.all(Array.from({ length: 5 }, async (_, ordinal) => readCheckpointAudio(await checkpoint(work.storyId, "speech", ordinal)))); const effectRecord = await checkpoint(work.storyId, "effect"); const effect = effectRecord ? await readCheckpointAudio(effectRecord) : null; const mixed = await deps.mix({ segments, effect, maxDurationSeconds: work.maxDurationSeconds }); record = await writeAudioCheckpoint(work, "mix", -1, mixed.audio, { segmentDurationsMs: mixed.segmentDurationsMs }); }
      if (!record) throw new Error("story_mix_checkpoint_uncertain"); await requeue(work, "persist", 90); return { status: "advanced" as const, stage: "mix" };
    }
    if (stage === "persist") {
      const recovered = await deps.recoverPersisted(work); if (!recovered) {
        const segments = await Promise.all(Array.from({ length: 5 }, async (_, ordinal) => readCheckpointAudio(await checkpoint(work.storyId, "speech", ordinal)))); const mixRecord = await checkpoint(work.storyId, "mix"); const audio = await readCheckpointAudio(mixRecord); const moderation = (await checkpoint(work.storyId, "moderation"))!.payload as { model: string; requestId: string; verdict: "safe" }; const speech = await Promise.all(Array.from({ length: 5 }, async (_, ordinal) => (await checkpoint(work.storyId, "speech", ordinal))!.payload as { model: string; requestId: string })); const durations = (mixRecord!.payload as { segmentDurationsMs?: unknown }).segmentDurationsMs;
        if (!Array.isArray(durations) || durations.length !== 5) throw new Error("story_mix_alignment_invalid");
        await deps.persist(work, { audio, segments, segmentDurationsMs: durations.map(Number), narrations: writer.segments.map((item) => item.narration), provenance: { planVersion: "nearstory-plan-v1", promptVersion: "nearstory-segment-v1", writer: { model: writer.model, requestId: writer.requestId }, moderation, speech: speech.map((item, ordinal) => ({ ordinal, ...item })), effect: null } });
      }
      await requeue(work, "complete", 97); return { status: "advanced" as const, stage: "persist" };
    }
    if (stage === "complete") { const recovered = await deps.recoverPersisted(work); if (!recovered) throw new Error("story_persistence_uncertain"); await deps.requireConsent(work); await deps.complete(work, recovered); return { status: "completed" as const, result: recovered }; }
    throw new Error("story_stage_invalid");
  } catch (error) {
    if (error instanceof Error && /unsafe/.test(error.message)) return failOwned(work, "story_output_unsafe", deps);
    return { status: "retryable" as const, code: error instanceof Error ? error.message : "story_stage_failed" };
  }
}

export async function reconcileExhaustedNearStoryJobs(limit = 5) {
  const db = getDb(); const now = new Date();
  const records = await db.select({ jobId: sql<string>`${jobs.id}`.as("story_job_id"), householdId: sql<string>`${jobs.householdId}`.as("story_household_id"), storyId: sql<string>`${storyExperiences.id}`.as("story_id"), reservationId: sql<string | null>`${storyExperiences.reservationId}`.as("story_reservation_id"), leaseId: sql<string>`${storyExperiences.consentLeaseId}`.as("story_lease_id") })
    .from(jobs).innerJoin(storyExperiences, and(eq(storyExperiences.jobId, jobs.id), eq(storyExperiences.householdId, jobs.householdId)))
    .where(and(eq(jobs.type, "story_audio"), eq(jobs.status, "running"), lte(jobs.workerLeaseExpiresAt, now), eq(jobs.attempts, 3))).limit(Math.max(1, Math.min(limit, 20))).all();
  for (const record of records) {
    const holds = await db.select({ id: storyProviderBudgetHolds.id, status: storyProviderBudgetHolds.status, spendId: storyProviderBudgetHolds.providerSpendReservationId }).from(storyProviderBudgetHolds).where(and(eq(storyProviderBudgetHolds.householdId, record.householdId), eq(storyProviderBudgetHolds.storyId, record.storyId), inArray(storyProviderBudgetHolds.status, ["reserved", "claimed"]))).all();
    const spendIds = holds.map((hold) => hold.spendId).filter((id): id is string => Boolean(id));
    const spends = spendIds.length ? await db.select({ id: providerSpendReservations.id, status: providerSpendReservations.status }).from(providerSpendReservations).where(inArray(providerSpendReservations.id, spendIds)).all() : [];
    await db.batch([
      ...spends.map((spend) => db.update(providerSpendReservations).set({ status: spend.status === "charge_committed" ? "settled" as const : "released" as const, updatedAt: now }).where(and(eq(providerSpendReservations.id, spend.id), eq(providerSpendReservations.status, spend.status)))),
      ...holds.map((hold) => db.update(storyProviderBudgetHolds).set({ status: hold.status === "claimed" ? "settled" as const : "released" as const, updatedAt: now }).where(and(eq(storyProviderBudgetHolds.id, hold.id), eq(storyProviderBudgetHolds.status, hold.status)))),
      db.update(voiceConsentLeases).set({ status: "revoked", finalizedAt: now }).where(and(eq(voiceConsentLeases.id, record.leaseId), eq(voiceConsentLeases.householdId, record.householdId), eq(voiceConsentLeases.status, "active"))),
      ...(record.reservationId ? [db.update(usageReservations).set({ status: "released" as const, finalizedAt: now, updatedAt: now }).where(and(eq(usageReservations.id, record.reservationId), eq(usageReservations.householdId, record.householdId), eq(usageReservations.status, "reserved")))] : []),
      db.update(storyExperiences).set({ status: "failed", errorCode: "story_worker_attempts_exhausted", updatedAt: now }).where(and(eq(storyExperiences.id, record.storyId), eq(storyExperiences.householdId, record.householdId), inArray(storyExperiences.status, ["queued", "processing"]))),
      db.update(jobs).set({ status: "failed", errorCode: "story_worker_attempts_exhausted", progressStage: "failed", workerAttemptToken: null, workerLeaseExpiresAt: null, completedAt: now, updatedAt: now }).where(and(eq(jobs.id, record.jobId), eq(jobs.householdId, record.householdId), eq(jobs.status, "running"), eq(jobs.attempts, 3))),
    ] as never);
  }
  return records.length;
}

export async function reconcileStoryCheckpointCleanup(limit = 20) {
  const storage = bucket(); if (!storage) return 0;
  const rows = await getDb().select({ id: storyWorkerCheckpoints.id, key: storyWorkerCheckpoints.storageKey }).from(storyWorkerCheckpoints).innerJoin(storyExperiences, and(eq(storyWorkerCheckpoints.storyId, storyExperiences.id), eq(storyWorkerCheckpoints.householdId, storyExperiences.householdId))).where(inArray(storyExperiences.status, ["completed", "failed", "canceled", "delete_pending", "deleted"])).limit(Math.max(1, Math.min(limit, 100))).all();
  let cleaned = 0;
  for (const row of rows) {
    if (row.key) { await storage.delete(row.key).catch(() => undefined); if (await storage.head(row.key)) continue; }
    const deleted = await getDb().delete(storyWorkerCheckpoints).where(eq(storyWorkerCheckpoints.id, row.id)).returning({ id: storyWorkerCheckpoints.id }).get(); if (deleted) cleaned += 1;
  }
  // Published objects are now the canonical media objects. Select them in a
  // separate SQL branch so an adapter alias collision can never turn a
  // bookkeeping-row cleanup into deletion of retained family audio.
  const staging = await getDb().select({ id: storyPersistStagingObjects.id, key: storyPersistStagingObjects.storageKey }).from(storyPersistStagingObjects).innerJoin(storyExperiences, and(eq(storyPersistStagingObjects.storyId, storyExperiences.id), eq(storyPersistStagingObjects.householdId, storyExperiences.householdId))).where(and(inArray(storyExperiences.status, ["completed", "failed", "canceled", "delete_pending", "deleted"]), or(ne(storyPersistStagingObjects.status, "published"), ne(storyExperiences.status, "completed")))).limit(Math.max(1, Math.min(limit, 100))).all();
  for (const row of staging) {
    await storage.delete(row.key).catch(() => undefined); if (await storage.head(row.key)) continue;
    const deleted = await getDb().delete(storyPersistStagingObjects).where(eq(storyPersistStagingObjects.id, row.id)).returning({ id: storyPersistStagingObjects.id }).get(); if (deleted) cleaned += 1;
  }
  const published = await getDb().select({ id: storyPersistStagingObjects.id }).from(storyPersistStagingObjects).innerJoin(storyExperiences, and(eq(storyPersistStagingObjects.storyId, storyExperiences.id), eq(storyPersistStagingObjects.householdId, storyExperiences.householdId))).where(and(eq(storyPersistStagingObjects.status, "published"), eq(storyExperiences.status, "completed"))).limit(Math.max(1, Math.min(limit, 100))).all();
  for (const row of published) { const deleted = await getDb().delete(storyPersistStagingObjects).where(and(eq(storyPersistStagingObjects.id, row.id), eq(storyPersistStagingObjects.status, "published"))).returning({ id: storyPersistStagingObjects.id }).get(); if (deleted) cleaned += 1; }
  return cleaned;
}
