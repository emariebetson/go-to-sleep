import { env } from "cloudflare:workers";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { deletionReconciliations, householdExports, mediaAssets, sleepSessions } from "@/db/schema";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { parseLibrarySessionUpdate } from "@/lib/nearsleep-library";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

type AudioBucket = {
  delete(key: string): Promise<void>;
  head(key: string): Promise<unknown | null>;
};

function bucket() {
  return (env as unknown as { AUDIO?: AudioBucket }).AUDIO;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { householdId } = await requireHouseholdContext(request, "playlist:write");
    const { id } = await context.params;
    let input;
    try { input = parseLibrarySessionUpdate(await readJsonObject(request, 2_000)); } catch (error) {
      return error instanceof Response ? error : badRequest(error);
    }
    const session = await getDb().update(sleepSessions).set(input).where(and(
      eq(sleepSessions.id, id),
      eq(sleepSessions.householdId, householdId),
      eq(sleepSessions.status, "ready"),
      eq(sleepSessions.deletionStatus, "active"),
    )).returning({ id: sleepSessions.id, favorite: sleepSessions.favorite, repeatMinutes: sleepSessions.repeatMinutes }).get();
    if (!session) return jsonNoStore({ error: "Session not found." }, { status: 404 });
    return jsonNoStore({ session });
  } catch (error) {
    return apiV1Failure(error, "The library session could not be updated.");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { householdId } = await requireHouseholdContext(request, "playlist:write");
    const { id } = await context.params;
    const db = getDb();
    let session = await db.select({
      id: sleepSessions.id,
      status: sleepSessions.status,
      deletionStatus: sleepSessions.deletionStatus,
      audioKey: sleepSessions.audioKey,
      mediaAssetId: sleepSessions.mediaAssetId,
    }).from(sleepSessions).where(and(eq(sleepSessions.id, id), eq(sleepSessions.householdId, householdId))).get();
    if (!session) return jsonNoStore({ error: "Session not found." }, { status: 404 });
    if (session.deletionStatus === "deleted") return jsonNoStore({ deleted: true, duplicate: true });
    if (session.deletionStatus === "active") {
      if (session.status !== "ready" || !session.audioKey || !session.mediaAssetId) return jsonNoStore({ error: "Session not found." }, { status: 404 });
      const savedMedia = await db.select({ id: mediaAssets.id }).from(mediaAssets).where(and(
        eq(mediaAssets.id, session.mediaAssetId), eq(mediaAssets.householdId, householdId), eq(mediaAssets.status, "ready"), eq(mediaAssets.private, true), eq(mediaAssets.storageKey, session.audioKey), isNull(mediaAssets.deletedAt),
      )).get();
      if (!savedMedia) return jsonNoStore({ error: "Session not found." }, { status: 404 });
    }
    const pendingExport = await db.select({ id: householdExports.id }).from(householdExports).where(and(
      eq(householdExports.householdId, householdId), inArray(householdExports.status, ["queued", "running", "failed"]), gt(householdExports.expiresAt, new Date()),
    )).get();
    if (pendingExport) return jsonNoStore({ error: "Finish or expire the active household export before deleting this session." }, { status: 409 });
    const now = new Date();
    if (session.deletionStatus === "active") {
      const denied = await db.update(sleepSessions).set({ deletionStatus: "delete_pending", deletionRequestedAt: now }).where(and(
        eq(sleepSessions.id, id), eq(sleepSessions.householdId, householdId), eq(sleepSessions.deletionStatus, "active"),
      )).returning({ id: sleepSessions.id }).get();
      if (!denied) return jsonNoStore({ error: "Session deletion conflicted with another request." }, { status: 409 });
      session = { ...session, deletionStatus: "delete_pending" };
    }
    await db.insert(deletionReconciliations).values({
      id: `session-delete:${id}`,
      scope: "session",
      scopeId: id,
      householdId,
      status: "cleanup_pending",
      storageKeys: session.audioKey ? [session.audioKey] : [],
      providerReferences: [],
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
    if (session.audioKey) {
      const storage = bucket();
      if (!storage) return jsonNoStore({ deleted: false, deletionStatus: "delete_pending", retryable: true, error: "Private audio cleanup is unavailable." }, { status: 503 });
      try {
        await storage.delete(session.audioKey);
        if (await storage.head(session.audioKey)) throw new Error("storage_object_still_present");
      } catch (error) {
        console.error("Session media deletion requires reconciliation", id, error);
        await db.update(deletionReconciliations).set({ errorCode: "storage_cleanup_retry", updatedAt: new Date() }).where(and(
          eq(deletionReconciliations.id, `session-delete:${id}`), eq(deletionReconciliations.status, "cleanup_pending"),
        )).catch(() => undefined);
        return jsonNoStore({ deleted: false, deletionStatus: "delete_pending", retryable: true }, { status: 202 });
      }
    }
    const completedAt = new Date();
    const statements = [
      ...(session.mediaAssetId ? [db.update(mediaAssets).set({ status: "deleted" as const, deletedAt: completedAt, updatedAt: completedAt }).where(and(
        eq(mediaAssets.id, session.mediaAssetId), eq(mediaAssets.householdId, householdId),
      ))] : []),
      db.update(sleepSessions).set({ deletionStatus: "deleted", deletedAt: completedAt }).where(and(
        eq(sleepSessions.id, id), eq(sleepSessions.householdId, householdId), eq(sleepSessions.deletionStatus, "delete_pending"),
      )),
      db.update(deletionReconciliations).set({ status: "completed", errorCode: null, completedAt, updatedAt: completedAt }).where(and(
        eq(deletionReconciliations.id, `session-delete:${id}`), eq(deletionReconciliations.status, "cleanup_pending"),
      )),
    ];
    await db.batch(statements as [typeof statements[number], ...Array<typeof statements[number]>]);
    return jsonNoStore({ deleted: true });
  } catch (error) {
    let detail = "";
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
      if ("message" in current && typeof current.message === "string") detail += ` ${current.message}`;
      current = "cause" in current ? current.cause : null;
    }
    if (detail.includes("active_household_export")) return jsonNoStore({ error: "Finish or expire the active household export before deleting this session." }, { status: 409 });
    return apiV1Failure(error, "Session deletion could not be completed; playback remains disabled while cleanup retries.");
  }
}
