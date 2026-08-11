import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { getDb } from "@/db";
import { deletionReconciliations, householdExports, mediaAssets, sleepSessions } from "@/db/schema";
import { fetchWithTimeout } from "./http";

type DeletionBucket = { delete(key: string): Promise<void>; head(key: string): Promise<unknown | null> };

const CLEANUP_ACTIONS_PER_RUN = 2;

async function deleteProviderReference(reference: string) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("provider_unavailable");
  const response = await fetchWithTimeout(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(reference)}`, {
    method: "DELETE", headers: { "xi-api-key": apiKey },
  }, 20_000);
  if (!response.ok && response.status !== 404) throw new Error("provider_cleanup_retry");
}

export async function reconcilePendingDeletionReconciliations(input: { bucket?: DeletionBucket; limit?: number; actionLimit?: number }) {
  const db = getDb();
  const now = new Date();
  const records = await db.select().from(deletionReconciliations).where(and(
    isNotNull(deletionReconciliations.householdId),
    or(
      inArray(deletionReconciliations.status, ["cleanup_pending", "failed"]),
      and(eq(deletionReconciliations.status, "cleanup_verified"), or(isNull(deletionReconciliations.attemptExpiresAt), lte(deletionReconciliations.attemptExpiresAt, now))),
    ),
  )).orderBy(asc(deletionReconciliations.updatedAt)).limit(Math.min(20, Math.max(1, input.limit || 10))).all();
  let actionBudget = Math.min(50, Math.max(1, input.actionLimit || CLEANUP_ACTIONS_PER_RUN));
  for (const record of records) {
    if (actionBudget <= 0) break;
    const attemptToken = crypto.randomUUID();
    const attemptExpiresAt = new Date(Date.now() + 2 * 60_000);
    const claimed = await db.update(deletionReconciliations).set({
      status: "cleanup_verified", attemptToken, attemptExpiresAt, errorCode: null, updatedAt: new Date(),
    }).where(and(
      eq(deletionReconciliations.id, record.id),
      or(
        inArray(deletionReconciliations.status, ["cleanup_pending", "failed"]),
        and(eq(deletionReconciliations.status, "cleanup_verified"), or(isNull(deletionReconciliations.attemptExpiresAt), lte(deletionReconciliations.attemptExpiresAt, now))),
      ),
    )).returning({ id: deletionReconciliations.id }).get();
    if (!claimed) continue;
    let providerReferences = Array.isArray(record.providerReferences) ? record.providerReferences.filter((value): value is string => typeof value === "string") : [];
    let storageKeys = Array.isArray(record.storageKeys) ? record.storageKeys.filter((value): value is string => typeof value === "string") : [];
    try {
      while (providerReferences.length && actionBudget > 0) {
        await deleteProviderReference(providerReferences[0]);
        providerReferences = providerReferences.slice(1);
        actionBudget -= 1;
        await db.update(deletionReconciliations).set({ providerReferences, updatedAt: new Date() }).where(and(
          eq(deletionReconciliations.id, record.id), eq(deletionReconciliations.attemptToken, attemptToken),
        ));
      }
      while (storageKeys.length && actionBudget > 0) {
        if (!input.bucket) throw new Error("storage_unavailable");
        await input.bucket.delete(storageKeys[0]);
        if (await input.bucket.head(storageKeys[0])) throw new Error("storage_cleanup_retry");
        storageKeys = storageKeys.slice(1);
        actionBudget -= 1;
        await db.update(deletionReconciliations).set({ storageKeys, updatedAt: new Date() }).where(and(
          eq(deletionReconciliations.id, record.id), eq(deletionReconciliations.attemptToken, attemptToken),
        ));
      }
      const completed = providerReferences.length === 0 && storageKeys.length === 0;
      const completedAt = completed ? new Date() : null;
      await db.update(deletionReconciliations).set({
        status: completed ? "completed" : "cleanup_pending",
        attemptToken: null,
        attemptExpiresAt: null,
        errorCode: null,
        completedAt,
        updatedAt: completedAt || new Date(),
      }).where(and(eq(deletionReconciliations.id, record.id), eq(deletionReconciliations.attemptToken, attemptToken)));
    } catch (error) {
      const errorCode = error instanceof Error && ["provider_unavailable", "provider_cleanup_retry", "storage_unavailable"].includes(error.message)
        ? error.message : "storage_cleanup_retry";
      await db.update(deletionReconciliations).set({
        status: "failed", attemptToken: null, attemptExpiresAt: null, errorCode, updatedAt: new Date(),
      }).where(and(eq(deletionReconciliations.id, record.id), eq(deletionReconciliations.attemptToken, attemptToken)));
    }
  }
  return records.length;
}

export async function reconcilePendingSessionDeletions(input: { bucket: DeletionBucket; limit?: number }) {
  const db = getDb();
  const sessions = await db.select({
    id: sleepSessions.id,
    householdId: sleepSessions.householdId,
    audioKey: sleepSessions.audioKey,
    mediaAssetId: sleepSessions.mediaAssetId,
    deletionRequestedAt: sleepSessions.deletionRequestedAt,
  }).from(sleepSessions).where(eq(sleepSessions.deletionStatus, "delete_pending"))
    .orderBy(asc(sleepSessions.deletionRequestedAt)).limit(Math.min(20, Math.max(1, input.limit || 10))).all();
  for (const session of sessions) {
    if (!session.householdId) continue;
    const now = new Date();
    await db.insert(deletionReconciliations).values({
      id: `session-delete:${session.id}`,
      scope: "session",
      scopeId: session.id,
      householdId: session.householdId,
      status: "cleanup_pending",
      storageKeys: session.audioKey ? [session.audioKey] : [],
      providerReferences: [],
      createdAt: session.deletionRequestedAt || now,
      updatedAt: now,
    }).onConflictDoNothing();
    const pendingExport = await db.select({ id: householdExports.id }).from(householdExports).where(and(
      eq(householdExports.householdId, session.householdId), inArray(householdExports.status, ["queued", "running", "failed"]), gt(householdExports.expiresAt, new Date()),
    )).get();
    if (pendingExport) continue;
    try {
      if (session.audioKey) {
        await input.bucket.delete(session.audioKey);
        if (await input.bucket.head(session.audioKey)) throw new Error("storage_object_still_present");
      }
      const completedAt = new Date();
      const statements = [
        ...(session.mediaAssetId ? [db.update(mediaAssets).set({ status: "deleted" as const, deletedAt: completedAt, updatedAt: completedAt }).where(and(
          eq(mediaAssets.id, session.mediaAssetId), eq(mediaAssets.householdId, session.householdId), eq(mediaAssets.status, "ready"),
        ))] : []),
        db.update(sleepSessions).set({ deletionStatus: "deleted", deletedAt: completedAt }).where(and(
          eq(sleepSessions.id, session.id), eq(sleepSessions.householdId, session.householdId), eq(sleepSessions.deletionStatus, "delete_pending"),
        )),
        db.update(deletionReconciliations).set({ status: "completed", errorCode: null, completedAt, updatedAt: completedAt }).where(and(
          eq(deletionReconciliations.id, `session-delete:${session.id}`), eq(deletionReconciliations.status, "cleanup_pending"),
        )),
      ];
      await db.batch(statements as [typeof statements[number], ...Array<typeof statements[number]>]);
    } catch {
      await db.update(deletionReconciliations).set({ errorCode: "storage_cleanup_retry", updatedAt: new Date() }).where(and(
        eq(deletionReconciliations.id, `session-delete:${session.id}`), eq(deletionReconciliations.status, "cleanup_pending"),
      ));
    }
  }
  return sessions.length;
}
