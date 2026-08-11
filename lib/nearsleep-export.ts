import { and, asc, count, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  childProfiles,
  bedtimeQueueItems,
  householdExportMetadataPages,
  householdExportParts,
  householdExports,
  householdStorageReservations,
  households,
  mediaAssets,
  playlistItems,
  playlists,
  sleepSessions,
  storyBranchRequests,
  storyExperiences,
  storyMediaBindings,
  storySegments,
  voiceConsents,
} from "@/db/schema";
import { canonicalRequestHash, portableConsentEvidence, sha256Hex } from "./nearsleep-library";

export type ExportObject = {
  body?: BodyInit | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  size?: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

export type ExportBucket = {
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<ExportObject | null>;
  head(key: string): Promise<(ExportObject & { size: number; writeHttpMetadata?(headers: Headers): void }) | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string | ReadableStream, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
};

function nestedErrorDetail(error: unknown) {
  const details: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if ("message" in current && typeof current.message === "string") details.push(current.message);
    current = "cause" in current ? current.cause : null;
  }
  return details.join(" ");
}

const PARTS_PER_ATTEMPT = 10;
const EXPIRY_DELETES_PER_ATTEMPT = 10;
const EXPORT_DOWNLOAD_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const EXPORT_BUILD_DEADLINE_MS = 30 * 24 * 60 * 60 * 1000;
const INVENTORY_ROWS_PER_ATTEMPT = 50;
const MAX_METADATA_PAGE_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BACKFILL_BYTES = 10 * 1024 * 1024;

function publicExport(record: typeof householdExports.$inferSelect, downloadConfirmed = false) {
  return {
    id: record.id,
    requestId: record.idempotencyKey,
    status: record.status,
    stage: record.status === "succeeded" ? "ready" : record.status === "failed" ? "retry_required" : "copying_private_media",
    progress: record.inventoryCount ? Math.min(100, Math.floor(record.cursorPosition * 100 / record.inventoryCount)) : record.status === "succeeded" ? 100 : 0,
    inventoryCount: record.inventoryCount,
    expiresAt: record.expiresAt,
    retryable: record.status === "failed",
    downloadConfirmed,
    ...(record.status === "succeeded" ? { manifestUrl: `/api/account/export/${encodeURIComponent(record.id)}` } : {}),
  };
}

export async function claimHouseholdExport(input: { requestId: string; householdId: string; userId: string }) {
  const db = getDb();
  const requestHash = await canonicalRequestHash({ formatVersion: 1, scope: "portable_household_export" });
  const existing = await db.select().from(householdExports).where(and(
    eq(householdExports.householdId, input.householdId),
    eq(householdExports.requestedByUserId, input.userId),
    eq(householdExports.idempotencyKey, input.requestId),
  )).get();
  if (existing) {
    if (existing.requestHash !== requestHash) throw new Error("export_idempotency_conflict");
    return existing;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXPORT_BUILD_DEADLINE_MS);
  const household = await db.select({ name: households.name, createdAt: households.createdAt }).from(households).where(eq(households.id, input.householdId)).get();
  if (!household) throw new Error("export_household_missing");
  const snapshot = {
    format: "nearyou-portable-household-v1",
    exportedAt: now.toISOString(),
    household,
    packageLayout: "Fetch every authenticated metadata page and media part before expiry. Preserve each filename and verify its lowercase hexadecimal SHA-256 checksum from the page or manifest.",
  };
  const internalId = `export:${input.householdId}:${input.requestId}`;
  const exportInsert = db.insert(householdExports).values({
    id: internalId,
    householdId: input.householdId,
    requestedByUserId: input.userId,
    idempotencyKey: input.requestId,
    requestHash,
    snapshot,
    status: "queued",
    inventoryStage: "consents",
    inventoryCursor: null,
    inventoryCount: 0,
    cursorPosition: 0,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  try { await exportInsert; }
  catch (error) {
    const concurrent = await db.select().from(householdExports).where(and(
      eq(householdExports.householdId, input.householdId), eq(householdExports.requestedByUserId, input.userId), eq(householdExports.idempotencyKey, input.requestId),
    )).get();
    if (!concurrent) {
      if (nestedErrorDetail(error).includes("household_live_export_exists")) throw new Error("export_live_exists");
      throw error;
    }
    if (concurrent.requestHash !== requestHash) throw new Error("export_idempotency_conflict");
    return concurrent;
  }
  return (await db.select().from(householdExports).where(eq(householdExports.id, internalId)).get())!;
}

export async function advanceHouseholdExport(input: { exportId: string; householdId: string; userId: string; bucket: ExportBucket }) {
  const db = getDb();
  let record = await db.select().from(householdExports).where(and(
    eq(householdExports.id, input.exportId), eq(householdExports.householdId, input.householdId), eq(householdExports.requestedByUserId, input.userId),
  )).get();
  if (!record) return null;
  const exportId = record.id;
  if (record.expiresAt.getTime() <= Date.now()) {
    const now = new Date();
    if (record.attemptToken && record.attemptExpiresAt && record.attemptExpiresAt.getTime() > now.getTime()) return record;
    const attemptToken = crypto.randomUUID();
    const attemptExpiresAt = new Date(now.getTime() + 2 * 60 * 1000);
    const claimed = await db.update(householdExports).set({
      status: "failed",
      attemptToken,
      attemptExpiresAt,
      errorCode: "export_expiry_cleanup_pending",
      updatedAt: now,
    }).where(and(
      eq(householdExports.id, record.id),
      eq(householdExports.householdId, input.householdId),
      or(isNull(householdExports.attemptToken), lte(householdExports.attemptExpiresAt, now)),
    )).returning({ id: householdExports.id }).get();
    if (!claimed) return record;
    try {
      const pages = await db.select({ id: householdExportMetadataPages.id, key: householdExportMetadataPages.storageKey })
        .from(householdExportMetadataPages).where(and(eq(householdExportMetadataPages.exportId, record.id), ne(householdExportMetadataPages.status, "expired")))
        .orderBy(asc(householdExportMetadataPages.position)).limit(EXPIRY_DELETES_PER_ATTEMPT).all();
      for (const page of pages) {
        await input.bucket.delete(page.key);
        if (await input.bucket.head(page.key)) throw new Error("export_expiry_delete_not_verified");
        await db.update(householdExportMetadataPages).set({ status: "expired" }).where(and(
          eq(householdExportMetadataPages.id, page.id), eq(householdExportMetadataPages.exportId, record.id), ne(householdExportMetadataPages.status, "expired"),
        ));
      }
      const partBudget = Math.max(0, EXPIRY_DELETES_PER_ATTEMPT - pages.length);
      const parts = partBudget ? await db.select({ id: householdExportParts.id, key: householdExportParts.exportStorageKey })
        .from(householdExportParts).where(and(eq(householdExportParts.exportId, record.id), ne(householdExportParts.status, "failed")))
        .orderBy(asc(householdExportParts.id)).limit(partBudget).all() : [];
      for (const part of parts) {
        await input.bucket.delete(part.key);
        if (await input.bucket.head(part.key)) throw new Error("export_expiry_delete_not_verified");
        await db.update(householdExportParts).set({ status: "failed", updatedAt: new Date() }).where(and(
          eq(householdExportParts.id, part.id), eq(householdExportParts.exportId, record.id), ne(householdExportParts.status, "failed"),
        ));
      }
      const remainingPage = await db.select({ id: householdExportMetadataPages.id }).from(householdExportMetadataPages).where(and(
        eq(householdExportMetadataPages.exportId, record.id), ne(householdExportMetadataPages.status, "expired"),
      )).limit(1).get();
      const remaining = remainingPage || await db.select({ id: householdExportParts.id }).from(householdExportParts).where(and(
        eq(householdExportParts.exportId, record.id), ne(householdExportParts.status, "failed"),
      )).limit(1).get();
      if (remaining) {
        await db.update(householdExports).set({ attemptToken: null, attemptExpiresAt: null, updatedAt: new Date() }).where(and(
          eq(householdExports.id, record.id), eq(householdExports.attemptToken, attemptToken),
        ));
      } else {
        if (record.manifestStorageKey) {
          await input.bucket.delete(record.manifestStorageKey);
          if (await input.bucket.head(record.manifestStorageKey)) throw new Error("export_expiry_delete_not_verified");
        }
        const expiredAt = new Date();
        await db.update(householdExports).set({
          status: "expired", attemptToken: null, attemptExpiresAt: null, errorCode: null, updatedAt: expiredAt,
        }).where(and(eq(householdExports.id, record.id), eq(householdExports.attemptToken, attemptToken)));
      }
    } catch {
      await db.update(householdExports).set({
        status: "failed", attemptToken: null, attemptExpiresAt: null, errorCode: "export_expiry_cleanup_retry", updatedAt: new Date(),
      }).where(and(eq(householdExports.id, record.id), eq(householdExports.attemptToken, attemptToken)));
    }
    return (await db.select().from(householdExports).where(eq(householdExports.id, record.id)).get())!;
  }
  if (record.status === "succeeded") return record;
  const now = new Date();
  if (record.status === "running" && record.attemptExpiresAt && record.attemptExpiresAt.getTime() > now.getTime()) return record;
  const attemptToken = crypto.randomUUID();
  const attemptExpiresAt = new Date(now.getTime() + 2 * 60 * 1000);
  const claimed = await db.update(householdExports).set({ status: "running", attemptToken, attemptExpiresAt, errorCode: null, updatedAt: now }).where(and(
    eq(householdExports.id, record.id), eq(householdExports.householdId, input.householdId),
    or(ne(householdExports.status, "running"), isNull(householdExports.attemptExpiresAt), lte(householdExports.attemptExpiresAt, now)),
  )).returning({ id: householdExports.id }).get();
  if (!claimed) return record;
  const requireActiveAttempt = async () => {
    const active = await db.select({ id: householdExports.id }).from(householdExports).where(and(
      eq(householdExports.id, exportId), eq(householdExports.status, "running"), eq(householdExports.attemptToken, attemptToken), gt(householdExports.attemptExpiresAt, new Date()),
    )).get();
    if (!active) throw new Error("export_attempt_invalidated");
  };
  const requireActiveAttemptAfterWrite = async (key: string) => {
    try {
      await requireActiveAttempt();
    } catch (error) {
      try { await input.bucket.delete(key); } catch { /* HEAD below decides whether durable expiry cleanup must retry. */ }
      let remaining = true;
      try { remaining = Boolean(await input.bucket.head(key)); } catch { /* The staged D1 key remains discoverable for expiry cleanup. */ }
      if (remaining) throw new Error("export_invalidated_write_cleanup_required");
      throw error;
    }
  };
  try {
    if (record.inventoryStage !== "copy") {
      const cutoff = record.createdAt;
      const kind = record.inventoryStage;
      const pageLimit = kind === "sessions" ? 10 : INVENTORY_ROWS_PER_ATTEMPT;
      let items: Record<string, unknown>[] = [];
      let sessions: Array<Record<string, unknown> & { id: string; mediaAssetId: string; storageKey: string | null; contentTypeMedia: string | null; byteSize: number | null; checksum: string | null; storageReservationStatus: string | null; reservedByteSize: number | null }> = [];
      let hasMore = false;
      let nextStage = "copy";
      const after = record.inventoryCursor;
      if (kind === "consents") {
        const rows = await db.select({ id: voiceConsents.id, voiceLocalId: voiceConsents.voiceId, version: voiceConsents.consentVersion, scope: voiceConsents.scope, status: voiceConsents.status, evidence: voiceConsents.evidence, attestedAt: voiceConsents.attestedAt, revokedAt: voiceConsents.revokedAt })
          .from(voiceConsents).where(and(eq(voiceConsents.householdId, input.householdId), lte(voiceConsents.attestedAt, cutoff), ...(after ? [gt(voiceConsents.id, after)] : [])))
          .orderBy(asc(voiceConsents.id)).limit(pageLimit + 1).all();
        hasMore = rows.length > pageLimit;
        items = rows.slice(0, pageLimit).map((row) => ({ ...row, evidence: portableConsentEvidence(row.evidence) }));
        nextStage = "children";
      } else if (kind === "children") {
        const rows = await db.select({ id: childProfiles.id, nickname: childProfiles.nickname, pronunciation: childProfiles.pronunciation, ageMonths: childProfiles.ageMonths, bedtimeChallenge: childProfiles.bedtimeChallenge, archivedAt: childProfiles.archivedAt })
          .from(childProfiles).where(and(eq(childProfiles.householdId, input.householdId), lte(childProfiles.createdAt, cutoff), ...(after ? [gt(childProfiles.id, after)] : [])))
          .orderBy(asc(childProfiles.id)).limit(pageLimit + 1).all();
        hasMore = rows.length > pageLimit;
        items = rows.slice(0, pageLimit);
        nextStage = "playlists";
      } else if (kind === "playlists") {
        const rows = await db.select({ id: playlists.id, name: playlists.name, createdAt: playlists.createdAt, updatedAt: playlists.updatedAt, deletedAt: playlists.deletedAt })
          .from(playlists).where(and(eq(playlists.householdId, input.householdId), lte(playlists.createdAt, cutoff), or(isNull(playlists.deletedAt), gt(playlists.deletedAt, cutoff)), ...(after ? [gt(playlists.id, after)] : [])))
          .orderBy(asc(playlists.id)).limit(pageLimit + 1).all();
        hasMore = rows.length > pageLimit;
        items = rows.slice(0, pageLimit).map((row) => ({ id: row.id, name: row.name, createdAt: row.createdAt, updatedAt: row.updatedAt }));
        nextStage = "playlist_items";
      } else if (kind === "playlist_items") {
        const rows = await db.select({ id: playlistItems.id, playlistId: playlistItems.playlistId, mediaAssetId: playlistItems.mediaAssetId, position: playlistItems.position, createdAt: playlistItems.createdAt })
          .from(playlistItems).innerJoin(playlists, and(eq(playlistItems.playlistId, playlists.id), eq(playlists.householdId, input.householdId), lte(playlists.createdAt, cutoff), or(isNull(playlists.deletedAt), gt(playlists.deletedAt, cutoff))))
          .where(and(lte(playlistItems.createdAt, cutoff), ...(after ? [gt(playlistItems.id, after)] : [])))
          .orderBy(asc(playlistItems.id)).limit(pageLimit + 1).all();
        hasMore = rows.length > pageLimit;
        items = rows.slice(0, pageLimit);
        nextStage = "bedtime_queue";
      } else if (kind === "bedtime_queue") {
        const rows = await db.select({ id: bedtimeQueueItems.id, sessionId: bedtimeQueueItems.sessionId, position: bedtimeQueueItems.position, status: bedtimeQueueItems.status, createdAt: bedtimeQueueItems.createdAt, updatedAt: bedtimeQueueItems.updatedAt })
          .from(bedtimeQueueItems).where(and(
            eq(bedtimeQueueItems.householdId, input.householdId),
            inArray(bedtimeQueueItems.status, ["queued", "playing"]),
            lte(bedtimeQueueItems.createdAt, cutoff),
            ...(after ? [gt(bedtimeQueueItems.id, after)] : []),
          )).orderBy(asc(bedtimeQueueItems.id)).limit(pageLimit + 1).all();
        hasMore = rows.length > pageLimit;
        items = rows.slice(0, pageLimit);
        nextStage = process.env.NEARYOU_ENABLE_STORY === "true" ? "stories" : "sessions";
      } else if (kind === "stories") {
        const rows = await db.select({ id: storyExperiences.id, childProfileId: storyExperiences.childProfileId, voiceId: storyExperiences.voiceId, consentId: storyExperiences.consentId, consentVersion: storyExperiences.consentVersion, mode: storyExperiences.mode, durationMinutes: storyExperiences.durationMinutes, plan: storyExperiences.plan, rightsActorUserId: storyExperiences.rightsActorUserId, rightsVersion: storyExperiences.rightsVersion, rightsCanonicalUrl: storyExperiences.rightsCanonicalUrl, rightsAttestedAt: storyExperiences.rightsAttestedAt, status: storyExperiences.status, createdAt: storyExperiences.createdAt, completedAt: storyExperiences.completedAt })
          .from(storyExperiences).where(and(eq(storyExperiences.householdId, input.householdId), lte(storyExperiences.createdAt, cutoff), ne(storyExperiences.status, "deleted"), ...(after ? [gt(storyExperiences.id, after)] : []))).orderBy(asc(storyExperiences.id)).limit(pageLimit + 1).all();
        hasMore = rows.length > pageLimit;
        items = await Promise.all(rows.slice(0, pageLimit).map(async (story) => ({ ...story,
          segments: await db.select({ branchKey: storySegments.branchKey, ordinal: storySegments.ordinal, purpose: storySegments.purpose, narration: storySegments.narration, status: storySegments.status, planVersion: storySegments.planVersion, promptVersion: storySegments.promptVersion, writerModel: storySegments.writerModel, writerRequestId: storySegments.writerRequestId, moderationModel: storySegments.moderationModel, moderationRequestId: storySegments.moderationRequestId, moderationVerdict: storySegments.moderationVerdict, ttsModel: storySegments.ttsModel, ttsRequestId: storySegments.ttsRequestId, mediaAssetId: storySegments.mediaAssetId }).from(storySegments).where(and(eq(storySegments.householdId, input.householdId), eq(storySegments.storyId, story.id))).orderBy(asc(storySegments.branchKey), asc(storySegments.ordinal)).all(),
          branches: await db.select({ id: storyBranchRequests.id, direction: storyBranchRequests.direction, afterSegment: storyBranchRequests.afterSegment, status: storyBranchRequests.status, moderationReceiptId: storyBranchRequests.moderationReceiptId, moderationProvenance: storyBranchRequests.moderationProvenance, createdAt: storyBranchRequests.createdAt }).from(storyBranchRequests).where(and(eq(storyBranchRequests.householdId, input.householdId), eq(storyBranchRequests.storyId, story.id))).orderBy(asc(storyBranchRequests.createdAt)).all(),
        })));
        nextStage = "story_media";
      } else if (kind === "story_media") {
        const page = await db.select({
          id: sql<string>`${storyMediaBindings.id}`.as("story_binding_id"), storyId: sql<string>`${storyMediaBindings.storyId}`.as("story_id"), role: sql<string>`${storyMediaBindings.role}`.as("story_media_role"), branchKey: sql<string>`${storyMediaBindings.branchKey}`.as("story_branch_key"), ordinal: sql<number | null>`${storyMediaBindings.ordinal}`.as("story_ordinal"),
          mediaAssetId: sql<string>`${mediaAssets.id}`.as("story_media_asset_id"), contentTypeMedia: sql<string | null>`${mediaAssets.contentType}`.as("story_content_type"), byteSize: sql<number | null>`${mediaAssets.byteSize}`.as("story_byte_size"), checksum: sql<string | null>`${mediaAssets.checksum}`.as("story_checksum"), storageKey: sql<string | null>`${mediaAssets.storageKey}`.as("story_storage_key"),
          storageReservationStatus: sql<string | null>`${householdStorageReservations.status}`.as("story_storage_status"), reservedByteSize: sql<number | null>`${householdStorageReservations.byteSize}`.as("story_reserved_bytes"), createdAt: sql<Date>`${storyMediaBindings.createdAt}`.as("story_created_at"),
        }).from(storyMediaBindings).innerJoin(mediaAssets, and(eq(storyMediaBindings.mediaAssetId, mediaAssets.id), eq(mediaAssets.householdId, input.householdId), eq(mediaAssets.status, "ready"), eq(mediaAssets.private, true), isNull(mediaAssets.deletedAt)))
          .leftJoin(householdStorageReservations, and(eq(householdStorageReservations.mediaAssetId, mediaAssets.id), eq(householdStorageReservations.householdId, input.householdId)))
          .where(and(eq(storyMediaBindings.householdId, input.householdId), eq(storyMediaBindings.status, "ready"), lte(storyMediaBindings.createdAt, cutoff), ...(after ? [gt(storyMediaBindings.id, after)] : []))).orderBy(asc(storyMediaBindings.id)).limit(pageLimit + 1).all();
        sessions = page.slice(0, pageLimit) as typeof sessions; hasMore = page.length > pageLimit;
        const currentExportId = record.id; const firstPartPosition = record.inventoryCount;
        items = sessions.map((session, index) => ({ ...Object.fromEntries(Object.entries(session).filter(([key]) => !["storageKey", "storageReservationStatus", "reservedByteSize", "contentTypeMedia"].includes(key))), mediaPartId: `${currentExportId}:part:${String(firstPartPosition + index).padStart(8, "0")}` }));
        nextStage = "sessions";
      } else if (kind === "sessions") {
        const page = await db.select({
        id: sleepSessions.id,
        title: sleepSessions.title,
        script: sleepSessions.script,
        scriptMode: sleepSessions.scriptMode,
        contentType: sleepSessions.contentType,
        narrationKind: sleepSessions.narrationKind,
        theme: sleepSessions.theme,
        style: sleepSessions.style,
        pronunciation: sleepSessions.pronunciation,
        sourceUrl: sleepSessions.sourceUrl,
        sourceTitle: sleepSessions.sourceTitle,
        backgroundSound: sleepSessions.backgroundSound,
        frequencyLayers: sleepSessions.frequencyLayers,
        durationMinutes: sleepSessions.durationMinutes,
        favorite: sleepSessions.favorite,
        repeatMinutes: sleepSessions.repeatMinutes,
        childProfileId: mediaAssets.childProfileId,
        voiceLocalId: sleepSessions.voiceId,
        consentId: sleepSessions.consentId,
        consentVersion: sleepSessions.consentVersion,
        mediaAssetId: mediaAssets.id,
        contentTypeMedia: mediaAssets.contentType,
        byteSize: mediaAssets.byteSize,
        checksum: mediaAssets.checksum,
        storageKey: mediaAssets.storageKey,
        storageReservationStatus: householdStorageReservations.status,
        reservedByteSize: householdStorageReservations.byteSize,
        createdAt: sleepSessions.createdAt,
        completedAt: sleepSessions.completedAt,
        }).from(sleepSessions).innerJoin(mediaAssets, and(
        eq(sleepSessions.mediaAssetId, mediaAssets.id), eq(mediaAssets.householdId, input.householdId),
        or(eq(mediaAssets.status, "ready"), and(eq(mediaAssets.status, "deleted"), gt(mediaAssets.deletedAt, cutoff))),
        eq(mediaAssets.private, true), or(isNull(mediaAssets.deletedAt), gt(mediaAssets.deletedAt, cutoff)),
      )).leftJoin(householdStorageReservations, and(
        eq(householdStorageReservations.mediaAssetId, mediaAssets.id), eq(householdStorageReservations.householdId, input.householdId),
      )).where(and(
        eq(sleepSessions.householdId, input.householdId), eq(sleepSessions.status, "ready"), lte(sleepSessions.completedAt, cutoff),
        or(isNull(sleepSessions.deletionRequestedAt), gt(sleepSessions.deletionRequestedAt, cutoff)),
        ...(record.inventoryCursor ? [gt(sleepSessions.id, record.inventoryCursor)] : []),
        )).orderBy(asc(sleepSessions.id)).limit(pageLimit + 1).all();
        sessions = page.slice(0, pageLimit) as typeof sessions;
        hasMore = page.length > pageLimit;
        const currentExportId = record.id;
        const firstPartPosition = record.inventoryCount;
        items = sessions.map((session, index) => ({ ...Object.fromEntries(Object.entries(session).filter(([key]) => !["storageKey", "storageReservationStatus", "reservedByteSize", "contentTypeMedia"].includes(key))), mediaPartId: `${currentExportId}:part:${String(firstPartPosition + index).padStart(8, "0")}` }));
        nextStage = "catalog";
      } else if (kind === "catalog") {
        const currentExportId = record.id;
        const rows = await db.select({
          id: householdExportMetadataPages.id,
          position: householdExportMetadataPages.position,
          kind: householdExportMetadataPages.kind,
          byteSize: householdExportMetadataPages.byteSize,
          checksum: householdExportMetadataPages.checksum,
        }).from(householdExportMetadataPages).where(and(
          eq(householdExportMetadataPages.exportId, record.id),
          ne(householdExportMetadataPages.kind, "integrity_catalog"),
          eq(householdExportMetadataPages.status, "ready"),
          ...(after ? [gt(householdExportMetadataPages.position, Number(after))] : []),
        )).orderBy(asc(householdExportMetadataPages.position)).limit(pageLimit + 1).all();
        hasMore = rows.length > pageLimit;
        items = rows.slice(0, pageLimit).map((row) => ({
          id: String(row.position),
          position: row.position,
          kind: row.kind,
          filename: `metadata-${String(row.position).padStart(8, "0")}.json`,
          byteSize: row.byteSize,
          sha256: row.checksum,
          downloadUrl: `/api/account/export/${encodeURIComponent(currentExportId)}/metadata/${row.position}`,
        }));
        nextStage = "copy";
      } else {
        throw new Error("export_inventory_stage_invalid");
      }
      if (sessions.some((session) => !session.storageKey || !session.byteSize || session.byteSize <= 0 || session.storageReservationStatus !== "committed" || session.reservedByteSize !== session.byteSize)) {
        throw new Error("export_media_reconciliation_required");
      }
      const nextCount = record.inventoryCount + sessions.length;
      const currentRecord = record;
      const partStatements = sessions.map((session, index) => {
        const position = currentRecord.inventoryCount + index;
        return db.insert(householdExportParts).values({
          id: `${currentRecord.id}:part:${String(position).padStart(8, "0")}`,
          exportId: currentRecord.id,
          sourceMediaAssetId: session.mediaAssetId,
          sourceStorageKey: session.storageKey!,
          exportStorageKey: `exports/${encodeURIComponent(input.householdId)}/${encodeURIComponent(currentRecord.id)}/parts/${String(position).padStart(8, "0")}.mp3`,
          contentType: session.contentTypeMedia || "application/octet-stream",
          byteSize: session.byteSize,
          checksum: session.checksum,
          status: "pending",
          expiresAt: currentRecord.expiresAt,
          createdAt: now,
          updatedAt: now,
        });
      });
      const pageStatements = [];
      if (items.length) {
        const position = record.metadataPageCount;
        const pageId = `${record.id}:metadata:${String(position).padStart(8, "0")}`;
        const pageKey = `exports/${encodeURIComponent(input.householdId)}/${encodeURIComponent(record.id)}/metadata/${String(position).padStart(8, "0")}.json`;
        const storedKind = kind === "catalog" ? "integrity_catalog" : kind;
        const priorCatalog = storedKind === "integrity_catalog" ? await db.select({ checksum: householdExportMetadataPages.checksum })
          .from(householdExportMetadataPages).where(and(eq(householdExportMetadataPages.exportId, record.id), eq(householdExportMetadataPages.kind, "integrity_catalog"), eq(householdExportMetadataPages.status, "ready")))
          .orderBy(desc(householdExportMetadataPages.position)).limit(1).get() : null;
        const pageBody = JSON.stringify({ format: "nearyou-portable-metadata-page-v1", kind: storedKind, position, ...(storedKind === "integrity_catalog" ? { previousCatalogSha256: priorCatalog?.checksum || null } : {}), items });
        const pageBytes = new TextEncoder().encode(pageBody);
        if (pageBytes.byteLength > MAX_METADATA_PAGE_BYTES) throw new Error("export_metadata_reconciliation_required");
        const checksum = await sha256Hex(pageBytes);
        await db.insert(householdExportMetadataPages).values({ id: pageId, exportId: record.id, position, kind: storedKind, storageKey: pageKey, itemCount: items.length, byteSize: pageBytes.byteLength, checksum, status: "pending", expiresAt: record.expiresAt, createdAt: now }).onConflictDoNothing();
        const staged = await db.select().from(householdExportMetadataPages).where(and(eq(householdExportMetadataPages.id, pageId), eq(householdExportMetadataPages.exportId, record.id))).get();
        if (!staged || staged.storageKey !== pageKey || staged.byteSize !== pageBytes.byteLength || staged.checksum !== checksum || staged.kind !== storedKind || staged.position !== position) throw new Error("export_metadata_stage_conflict");
        await requireActiveAttempt();
        const existing = await input.bucket.head(pageKey);
        if (!existing || existing.size !== pageBytes.byteLength || existing.customMetadata?.checksum !== checksum) {
          await requireActiveAttempt();
          await input.bucket.put(pageKey, pageBytes, { httpMetadata: { contentType: "application/json" }, customMetadata: { exportId: record.id, pageId, checksum, expiresAt: String(record.expiresAt.getTime()) } });
        }
        const head = await input.bucket.head(pageKey);
        if (!head || head.size !== pageBytes.byteLength || head.customMetadata?.checksum !== checksum) throw new Error("export_metadata_copy_verification_failed");
        await requireActiveAttemptAfterWrite(pageKey);
        pageStatements.push(db.update(householdExportMetadataPages).set({ status: "ready" }).where(and(eq(householdExportMetadataPages.id, pageId), eq(householdExportMetadataPages.exportId, record.id), ne(householdExportMetadataPages.status, "expired"))));
      }
      const inventoryUpdate = db.update(householdExports).set({
        inventoryCount: nextCount,
        metadataPageCount: record.metadataPageCount + (items.length ? 1 : 0),
        inventoryCursor: hasMore ? String(items.at(-1)!.id) : null,
        inventoryStage: hasMore ? kind : nextStage,
        status: "queued",
        attemptToken: null,
        attemptExpiresAt: null,
        errorCode: null,
        updatedAt: new Date(),
      }).where(and(eq(householdExports.id, record.id), eq(householdExports.status, "running"), eq(householdExports.attemptToken, attemptToken)));
      await db.batch([...pageStatements, ...partStatements, inventoryUpdate] as unknown as Parameters<typeof db.batch>[0]);
      record = (await db.select().from(householdExports).where(eq(householdExports.id, record.id)).get())!;
      return record;
    }
    const pending = await db.select().from(householdExportParts).where(and(
      eq(householdExportParts.exportId, record.id), eq(householdExportParts.status, "pending"),
    )).orderBy(asc(householdExportParts.id)).limit(PARTS_PER_ATTEMPT).all();
    for (const part of pending) {
      await requireActiveAttempt();
      const source = await input.bucket.get(part.sourceStorageKey);
      if (!source) throw new Error("export_source_missing");
      if (source.size !== undefined && source.size !== part.byteSize) throw new Error("export_size_mismatch");
      let checksum = part.checksum;
      if (checksum && source.customMetadata?.checksum !== checksum) throw new Error("export_checksum_mismatch");
      let value: ArrayBuffer | ReadableStream;
      if (checksum && source.body instanceof ReadableStream) value = source.body;
      else {
        if (!checksum && part.byteSize !== null && part.byteSize > MAX_CHECKSUM_BACKFILL_BYTES) throw new Error("export_checksum_reconciliation_required");
        const bytes = await source.arrayBuffer();
        if (bytes.byteLength !== part.byteSize) throw new Error("export_size_mismatch");
        checksum ||= await sha256Hex(bytes);
        value = bytes;
      }
      await requireActiveAttempt();
      await input.bucket.put(part.exportStorageKey, value, {
        httpMetadata: { contentType: part.contentType },
        customMetadata: { exportId: record.id, partId: part.id, checksum, expiresAt: String(record.expiresAt.getTime()) },
      });
      const copiedHead = await input.bucket.head(part.exportStorageKey);
      if (!copiedHead || copiedHead.size !== part.byteSize || copiedHead.customMetadata?.checksum !== checksum) { await input.bucket.delete(part.exportStorageKey).catch(() => undefined); throw new Error("export_copy_verification_failed"); }
      await requireActiveAttemptAfterWrite(part.exportStorageKey);
      await db.batch([
        db.update(householdExportParts).set({ status: "copied", checksum, updatedAt: new Date() }).where(and(
          eq(householdExportParts.id, part.id), eq(householdExportParts.exportId, record.id), eq(householdExportParts.status, "pending"),
        )),
        ...(part.sourceMediaAssetId && !part.checksum ? [db.update(mediaAssets).set({ checksum, updatedAt: new Date() }).where(and(
          eq(mediaAssets.id, part.sourceMediaAssetId), eq(mediaAssets.householdId, input.householdId), eq(mediaAssets.status, "ready"),
        ))] : []),
      ] as unknown as Parameters<typeof db.batch>[0]);
    }
    const copied = await db.select({ value: count() }).from(householdExportParts).where(and(
      eq(householdExportParts.exportId, record.id), eq(householdExportParts.status, "copied"),
    )).get();
    const copiedCount = copied?.value || 0;
    if (copiedCount < record.inventoryCount) {
      await db.update(householdExports).set({ cursorPosition: copiedCount, attemptToken: null, attemptExpiresAt: null, updatedAt: new Date() }).where(and(
        eq(householdExports.id, record.id), eq(householdExports.status, "running"), eq(householdExports.attemptToken, attemptToken),
      ));
    } else {
      const [contentPages, catalogPages, lastCatalog] = await Promise.all([
        db.select({ value: count() }).from(householdExportMetadataPages).where(and(eq(householdExportMetadataPages.exportId, record.id), ne(householdExportMetadataPages.kind, "integrity_catalog"), eq(householdExportMetadataPages.status, "ready"))).get(),
        db.select({ value: count() }).from(householdExportMetadataPages).where(and(eq(householdExportMetadataPages.exportId, record.id), eq(householdExportMetadataPages.kind, "integrity_catalog"), eq(householdExportMetadataPages.status, "ready"))).get(),
        db.select({ position: householdExportMetadataPages.position, checksum: householdExportMetadataPages.checksum }).from(householdExportMetadataPages).where(and(eq(householdExportMetadataPages.exportId, record.id), eq(householdExportMetadataPages.kind, "integrity_catalog"), eq(householdExportMetadataPages.status, "ready"))).orderBy(desc(householdExportMetadataPages.position)).limit(1).get(),
      ]);
      const manifest = {
        ...record.snapshot,
        metadataPages: { count: contentPages?.value || 0, urlTemplate: `/api/account/export/${encodeURIComponent(exportId)}/metadata/{position}` },
        integrityCatalog: { count: catalogPages?.value || 0, lastPosition: lastCatalog?.position ?? null, lastSha256: lastCatalog?.checksum ?? null, urlTemplate: `/api/account/export/${encodeURIComponent(exportId)}/metadata/{position}` },
        mediaParts: { count: record.inventoryCount, urlTemplate: `/api/account/export/${encodeURIComponent(exportId)}/parts/{partId}` },
      };
      const key = `exports/${encodeURIComponent(input.householdId)}/${encodeURIComponent(record.id)}/manifest.json`;
      const body = JSON.stringify(manifest);
      const bodyBytes = new TextEncoder().encode(body);
      const checksum = await sha256Hex(bodyBytes);
      await requireActiveAttempt();
      await db.update(householdExports).set({ manifestStorageKey: key, manifestByteSize: bodyBytes.byteLength, manifestChecksum: checksum, updatedAt: new Date() }).where(and(eq(householdExports.id, record.id), eq(householdExports.status, "running"), eq(householdExports.attemptToken, attemptToken)));
      await requireActiveAttempt();
      const existing = await input.bucket.head(key);
      if (!existing || existing.size !== bodyBytes.byteLength || existing.customMetadata?.checksum !== checksum) {
        await requireActiveAttempt();
        await input.bucket.put(key, body, { httpMetadata: { contentType: "application/json" }, customMetadata: { exportId: record.id, checksum, expiresAt: String(record.expiresAt.getTime()) } });
      }
      const manifestHead = await input.bucket.head(key);
      if (!manifestHead || manifestHead.size !== bodyBytes.byteLength || manifestHead.customMetadata?.checksum !== checksum) throw new Error("export_manifest_copy_verification_failed");
      await requireActiveAttemptAfterWrite(key);
      const completedAt = new Date();
      const downloadExpiresAt = new Date(completedAt.getTime() + EXPORT_DOWNLOAD_LIFETIME_MS);
      await db.batch([
        db.update(householdExportMetadataPages).set({ expiresAt: downloadExpiresAt }).where(eq(householdExportMetadataPages.exportId, record.id)),
        db.update(householdExportParts).set({ expiresAt: downloadExpiresAt, updatedAt: completedAt }).where(eq(householdExportParts.exportId, record.id)),
        db.update(householdExports).set({ status: "succeeded", cursorPosition: record.inventoryCount, manifestStorageKey: key, manifestByteSize: bodyBytes.byteLength, manifestChecksum: checksum, expiresAt: downloadExpiresAt, attemptToken: null, attemptExpiresAt: null, errorCode: null, completedAt, updatedAt: completedAt }).where(and(
          eq(householdExports.id, record.id), eq(householdExports.status, "running"), eq(householdExports.attemptToken, attemptToken),
        )),
      ] as unknown as Parameters<typeof db.batch>[0]);
    }
  } catch (error) {
    console.error("Household export reconciliation failed", { exportId, code: error instanceof Error ? error.message : "unknown" });
    const code = error instanceof Error && ["export_source_missing", "export_checksum_mismatch", "export_size_mismatch", "export_checksum_reconciliation_required"].includes(error.message) ? error.message : "export_retry_required";
    await db.update(householdExports).set({ status: "failed", attemptToken: null, attemptExpiresAt: null, errorCode: code, updatedAt: new Date() }).where(and(
      eq(householdExports.id, exportId), eq(householdExports.status, "running"), eq(householdExports.attemptToken, attemptToken),
    ));
  }
  record = (await db.select().from(householdExports).where(eq(householdExports.id, record.id)).get())!;
  return record;
}

export async function reconcileHouseholdExports(input: { bucket: ExportBucket; limit?: number }) {
  const db = getDb();
  const now = new Date();
  const records = await db.select({
    id: householdExports.id,
    householdId: householdExports.householdId,
    userId: householdExports.requestedByUserId,
  }).from(householdExports).where(or(
    eq(householdExports.status, "queued"),
    eq(householdExports.status, "failed"),
    and(eq(householdExports.status, "running"), or(isNull(householdExports.attemptExpiresAt), lte(householdExports.attemptExpiresAt, now))),
    and(eq(householdExports.status, "succeeded"), lte(householdExports.expiresAt, now)),
  )).orderBy(asc(householdExports.updatedAt)).limit(Math.min(20, Math.max(1, input.limit || 10))).all();
  for (const record of records) await advanceHouseholdExport({ exportId: record.id, householdId: record.householdId, userId: record.userId, bucket: input.bucket });
  return records.length;
}

export { publicExport };
