import { and, asc, eq, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { getDb } from "@/db";
import { jobs, mediaAssets, providerSpendReservations, storyBranchRequests, storyDeletionOperations, storyExperiences, storyMediaBindings, storyPersistStagingObjects, storyProviderBudgetHolds, storyWorkerCheckpoints, usageReservations, voiceConsentLeases } from "@/db/schema";

export type StoryDeletionBucket = { delete(key: string): Promise<void>; head(key: string): Promise<unknown | null> };

export async function reconcilePendingStoryDeletions(input: { bucket: StoryDeletionBucket; limit?: number }) {
  const db = getDb();
  const now = new Date();
  const records = await db.select().from(storyDeletionOperations).where(or(
    inArray(storyDeletionOperations.status, ["inventory_pending", "cleanup_pending", "failed"]),
    and(eq(storyDeletionOperations.status, "cleanup_verified"), or(isNull(storyDeletionOperations.attemptExpiresAt), lte(storyDeletionOperations.attemptExpiresAt, now))),
  )).orderBy(asc(storyDeletionOperations.updatedAt)).limit(Math.min(20, Math.max(1, input.limit || 10))).all();
  for (const record of records) {
    const attemptToken = crypto.randomUUID();
    const attemptExpiresAt = new Date(Date.now() + 2 * 60_000);
    const claimed = await db.update(storyDeletionOperations).set({ status: "cleanup_verified", attemptToken, attemptExpiresAt, errorCode: null, updatedAt: now }).where(and(
      eq(storyDeletionOperations.id, record.id),
      or(inArray(storyDeletionOperations.status, ["inventory_pending", "cleanup_pending", "failed"]), and(eq(storyDeletionOperations.status, "cleanup_verified"), or(isNull(storyDeletionOperations.attemptExpiresAt), lte(storyDeletionOperations.attemptExpiresAt, now)))),
    )).returning({ id: storyDeletionOperations.id }).get();
    if (!claimed) continue;
    const linkedMedia = await db.select({ key: mediaAssets.storageKey }).from(storyMediaBindings).innerJoin(mediaAssets, and(eq(storyMediaBindings.mediaAssetId, mediaAssets.id), eq(mediaAssets.householdId, record.householdId)))
      .where(and(eq(storyMediaBindings.householdId, record.householdId), eq(storyMediaBindings.storyId, record.storyId))).all();
    const checkpointMedia = await db.select({ key: storyWorkerCheckpoints.storageKey }).from(storyWorkerCheckpoints).where(and(eq(storyWorkerCheckpoints.householdId, record.householdId), eq(storyWorkerCheckpoints.storyId, record.storyId))).all();
    const persistStaging = await db.select({ key: storyPersistStagingObjects.storageKey }).from(storyPersistStagingObjects).where(and(eq(storyPersistStagingObjects.householdId, record.householdId), eq(storyPersistStagingObjects.storyId, record.storyId), ne(storyPersistStagingObjects.status, "deleted"))).all();
    let storageKeys = [...new Set([
      ...(Array.isArray(record.storageKeys) ? record.storageKeys.filter((key): key is string => typeof key === "string" && key.length > 0) : []),
      ...linkedMedia.map((item) => item.key).filter((key): key is string => Boolean(key)),
      ...checkpointMedia.map((item) => item.key).filter((key): key is string => Boolean(key)),
      ...persistStaging.map((item) => item.key),
    ])];
    await db.update(storyDeletionOperations).set({ storageKeys, status: "cleanup_verified", updatedAt: new Date() }).where(and(eq(storyDeletionOperations.id, record.id), eq(storyDeletionOperations.attemptToken, attemptToken)));
    try {
      while (storageKeys.length) {
        const key = storageKeys[0];
        try { await input.bucket.delete(key); } catch { /* HEAD determines durable state. */ }
        if (await input.bucket.head(key)) throw new Error("story_storage_cleanup_retry");
        storageKeys = storageKeys.slice(1);
        await db.update(storyDeletionOperations).set({ storageKeys, updatedAt: new Date() }).where(and(eq(storyDeletionOperations.id, record.id), eq(storyDeletionOperations.attemptToken, attemptToken)));
      }
      const completedAt = new Date();
      const ownedMedia = await db.select({ mediaId: storyMediaBindings.mediaAssetId }).from(storyMediaBindings).where(and(eq(storyMediaBindings.householdId, record.householdId), eq(storyMediaBindings.storyId, record.storyId))).all();
      const mediaIds = [...new Set(ownedMedia.map((row) => row.mediaId))];
      if (mediaIds.length) await db.update(mediaAssets).set({ status: "deleted", deletedAt: completedAt, updatedAt: completedAt }).where(and(eq(mediaAssets.householdId, record.householdId), inArray(mediaAssets.id, mediaIds), inArray(mediaAssets.status, ["processing", "ready", "failed"])));
      await db.batch([
        db.update(storyMediaBindings).set({ status: "deleted", updatedAt: completedAt }).where(and(eq(storyMediaBindings.householdId, record.householdId), eq(storyMediaBindings.storyId, record.storyId), ne(storyMediaBindings.status, "deleted"))),
        db.update(storyExperiences).set({ status: "deleted", mediaAssetId: null, deletedAt: completedAt, updatedAt: completedAt }).where(and(eq(storyExperiences.householdId, record.householdId), eq(storyExperiences.id, record.storyId), eq(storyExperiences.status, "delete_pending"))),
        db.update(storyDeletionOperations).set({ status: "completed", storageKeys: [], attemptToken: null, attemptExpiresAt: null, completedAt, updatedAt: completedAt }).where(and(eq(storyDeletionOperations.id, record.id), eq(storyDeletionOperations.attemptToken, attemptToken))),
      ]);
    } catch {
      await db.update(storyDeletionOperations).set({ status: "failed", storageKeys, attemptToken: null, attemptExpiresAt: null, errorCode: "story_storage_cleanup_retry", updatedAt: new Date() }).where(and(eq(storyDeletionOperations.id, record.id), eq(storyDeletionOperations.attemptToken, attemptToken)));
    }
  }
  return records.length;
}

export async function fenceStoryForDeletion(input: { householdId: string; storyId: string; operationId: string; idempotencyKey: string; requestHash: string }) {
  const db = getDb();
  const story = await db.select({
    status: storyExperiences.status, jobId: storyExperiences.jobId, reservationId: storyExperiences.reservationId,
    consentLeaseId: storyExperiences.consentLeaseId, finalMediaId: storyExperiences.mediaAssetId, finalKey: mediaAssets.storageKey,
  }).from(storyExperiences).leftJoin(mediaAssets, and(eq(storyExperiences.mediaAssetId, mediaAssets.id), eq(mediaAssets.householdId, input.householdId)))
    .where(and(eq(storyExperiences.id, input.storyId), eq(storyExperiences.householdId, input.householdId))).get();
  if (!story) return null;
  const existing = await db.select().from(storyDeletionOperations).where(and(eq(storyDeletionOperations.householdId, input.householdId), eq(storyDeletionOperations.idempotencyKey, input.idempotencyKey))).get();
  if (existing) {
    if (existing.storyId !== input.storyId || existing.requestHash !== input.requestHash) throw new Error("story_delete_idempotency_conflict");
    return existing;
  }
  const createdAt = new Date();
  const branches = await db.select({ jobId: storyBranchRequests.jobId, reservationId: storyBranchRequests.reservationId, leaseId: storyBranchRequests.consentLeaseId }).from(storyBranchRequests).where(and(eq(storyBranchRequests.householdId, input.householdId), eq(storyBranchRequests.storyId, input.storyId))).all();
  const branchJobIds = branches.map((branch) => branch.jobId); const branchReservationIds = branches.map((branch) => branch.reservationId); const branchLeaseIds = branches.map((branch) => branch.leaseId);
  const claimedSpends = await db.select({ id: providerSpendReservations.id, status: providerSpendReservations.status }).from(storyProviderBudgetHolds).innerJoin(providerSpendReservations, eq(storyProviderBudgetHolds.providerSpendReservationId, providerSpendReservations.id)).where(and(eq(storyProviderBudgetHolds.householdId, input.householdId), eq(storyProviderBudgetHolds.storyId, input.storyId), eq(storyProviderBudgetHolds.status, "claimed"))).all();
  try {
    await db.batch([
      db.insert(storyDeletionOperations).values({ id: input.operationId, householdId: input.householdId, storyId: input.storyId, idempotencyKey: input.idempotencyKey, requestHash: input.requestHash, storageKeys: [], status: "inventory_pending", createdAt, updatedAt: createdAt }),
    db.update(storyExperiences).set({ status: "delete_pending", updatedAt: createdAt }).where(and(eq(storyExperiences.id, input.storyId), eq(storyExperiences.householdId, input.householdId), inArray(storyExperiences.status, ["queued", "processing", "review_required", "completed", "failed", "canceled"]))),
    ...(story.jobId ? [db.update(jobs).set({ status: "canceled", errorCode: "story_deleted", completedAt: createdAt, updatedAt: createdAt }).where(and(eq(jobs.id, story.jobId), eq(jobs.householdId, input.householdId), inArray(jobs.status, ["queued", "running"])))] : []),
    ...(branchJobIds.length ? [db.update(jobs).set({ status: "canceled", errorCode: "story_deleted", completedAt: createdAt, updatedAt: createdAt }).where(and(eq(jobs.householdId, input.householdId), inArray(jobs.id, branchJobIds), inArray(jobs.status, ["queued", "running"])))] : []),
    db.update(storyProviderBudgetHolds).set({ status: "released", updatedAt: createdAt }).where(and(eq(storyProviderBudgetHolds.storyId, input.storyId), eq(storyProviderBudgetHolds.householdId, input.householdId), eq(storyProviderBudgetHolds.status, "reserved"))),
    db.update(storyProviderBudgetHolds).set({ status: "settled", updatedAt: createdAt }).where(and(eq(storyProviderBudgetHolds.storyId, input.storyId), eq(storyProviderBudgetHolds.householdId, input.householdId), eq(storyProviderBudgetHolds.status, "claimed"))),
    ...(story.reservationId && story.status !== "completed" ? [db.update(usageReservations).set({ status: "released", finalizedAt: createdAt, updatedAt: createdAt }).where(and(eq(usageReservations.id, story.reservationId), eq(usageReservations.householdId, input.householdId), eq(usageReservations.status, "reserved")))] : []),
    ...(branchReservationIds.length ? [db.update(usageReservations).set({ status: "released", finalizedAt: createdAt, updatedAt: createdAt }).where(and(eq(usageReservations.householdId, input.householdId), inArray(usageReservations.id, branchReservationIds), eq(usageReservations.status, "reserved")))] : []),
    db.update(voiceConsentLeases).set({ status: "revoked", finalizedAt: createdAt }).where(and(eq(voiceConsentLeases.id, story.consentLeaseId), eq(voiceConsentLeases.householdId, input.householdId), eq(voiceConsentLeases.status, "active"))),
    ...(branchLeaseIds.length ? [db.update(voiceConsentLeases).set({ status: "revoked", finalizedAt: createdAt }).where(and(eq(voiceConsentLeases.householdId, input.householdId), inArray(voiceConsentLeases.id, branchLeaseIds), eq(voiceConsentLeases.status, "active")))] : []),
      ...claimedSpends.map((spend) => db.update(providerSpendReservations).set({ status: spend.status === "charge_committed" ? "settled" as const : "released" as const, updatedAt: createdAt }).where(and(eq(providerSpendReservations.id, spend.id), eq(providerSpendReservations.status, spend.status)))),
    ] as never);
  } catch (error) {
    const live = await db.select().from(storyDeletionOperations).where(and(
      eq(storyDeletionOperations.householdId, input.householdId),
      eq(storyDeletionOperations.storyId, input.storyId),
      ne(storyDeletionOperations.status, "completed"),
    )).get();
    if (live) return live;
    throw error;
  }
  const fencedSpends = await db.select({ id: providerSpendReservations.id, status: providerSpendReservations.status }).from(storyProviderBudgetHolds).innerJoin(providerSpendReservations, eq(storyProviderBudgetHolds.providerSpendReservationId, providerSpendReservations.id)).where(and(eq(storyProviderBudgetHolds.householdId, input.householdId), eq(storyProviderBudgetHolds.storyId, input.storyId), inArray(providerSpendReservations.status, ["in_flight", "charge_committed"]))).all();
  for (const spend of fencedSpends) await db.update(providerSpendReservations).set({ status: spend.status === "charge_committed" ? "settled" : "released", updatedAt: new Date() }).where(and(eq(providerSpendReservations.id, spend.id), eq(providerSpendReservations.status, spend.status)));
  const boundMedia = await db.select({ key: mediaAssets.storageKey }).from(storyMediaBindings).innerJoin(mediaAssets, and(eq(storyMediaBindings.mediaAssetId, mediaAssets.id), eq(mediaAssets.householdId, input.householdId)))
    .where(and(eq(storyMediaBindings.householdId, input.householdId), eq(storyMediaBindings.storyId, input.storyId))).all();
  const checkpoints = await db.select({ key: storyWorkerCheckpoints.storageKey }).from(storyWorkerCheckpoints).where(and(eq(storyWorkerCheckpoints.householdId, input.householdId), eq(storyWorkerCheckpoints.storyId, input.storyId))).all();
  const persistStaging = await db.select({ key: storyPersistStagingObjects.storageKey }).from(storyPersistStagingObjects).where(and(eq(storyPersistStagingObjects.householdId, input.householdId), eq(storyPersistStagingObjects.storyId, input.storyId), ne(storyPersistStagingObjects.status, "deleted"))).all();
  const storageKeys = [...new Set([story.finalKey, ...boundMedia.map((item) => item.key), ...checkpoints.map((item) => item.key), ...persistStaging.map((item) => item.key)].filter((key): key is string => Boolean(key)))];
  await db.update(storyDeletionOperations).set({ storageKeys, status: "cleanup_pending", updatedAt: new Date() }).where(and(eq(storyDeletionOperations.id, input.operationId), eq(storyDeletionOperations.status, "inventory_pending")));
  return (await db.select().from(storyDeletionOperations).where(eq(storyDeletionOperations.id, input.operationId)).get())!;
}
