import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { householdStorageReservations, mediaAssets, task2cActivationState, task2cMediaIntegrity } from "@/db/schema";
import { sha256Hex } from "./nearsleep-library";

const MAX_LEGACY_OBJECT_BYTES = 32 * 1024 * 1024;

type StorageBucket = {
  head(key: string): Promise<{ size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } | null>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
};

const unresolvedWhere = or(
  isNull(mediaAssets.byteSize),
  sql`${mediaAssets.byteSize} <= 0`,
  isNull(mediaAssets.checksum),
  sql`length(COALESCE(${mediaAssets.checksum},'')) <> 64`,
  sql`lower(COALESCE(${mediaAssets.checksum},'')) GLOB '*[^0-9a-f]*'`,
  sql`NOT EXISTS (SELECT 1 FROM household_storage_reservations r WHERE r.media_asset_id = ${mediaAssets.id} AND r.household_id = ${mediaAssets.householdId} AND r.byte_size = ${mediaAssets.byteSize} AND r.status = 'committed')`,
  sql`NOT EXISTS (SELECT 1 FROM task2c_media_integrity i WHERE i.media_asset_id = ${mediaAssets.id} AND i.byte_size = ${mediaAssets.byteSize} AND i.checksum = ${mediaAssets.checksum})`,
);

export async function reconcileLegacyReadyMedia(input: { bucket: StorageBucket; limit?: number }) {
  const db = getDb();
  const rows = await db.select({ id: mediaAssets.id, householdId: mediaAssets.householdId, storageKey: mediaAssets.storageKey, contentType: mediaAssets.contentType })
    .from(mediaAssets).where(and(eq(mediaAssets.status, "ready"), unresolvedWhere)).orderBy(asc(mediaAssets.id)).limit(Math.min(4, Math.max(1, input.limit || 2))).all();
  let processed = 0;
  for (const row of rows) {
    if (!row.storageKey) continue;
    const head = await input.bucket.head(row.storageKey);
    if (!head || head.size <= 0 || head.size > MAX_LEGACY_OBJECT_BYTES) continue;
    const object = await input.bucket.get(row.storageKey);
    if (!object) continue;
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== head.size) continue;
    const checksum = await sha256Hex(bytes);
    await input.bucket.put(row.storageKey, bytes, {
      httpMetadata: { contentType: head.httpMetadata?.contentType || row.contentType || undefined },
      customMetadata: { ...(head.customMetadata || {}), checksum },
    });
    const verified = await input.bucket.head(row.storageKey);
    if (!verified || verified.size !== bytes.byteLength || verified.customMetadata?.checksum !== checksum) continue;
    const now = new Date();
    await db.update(mediaAssets).set({ byteSize: bytes.byteLength, checksum, updatedAt: now }).where(and(
      eq(mediaAssets.id, row.id), eq(mediaAssets.householdId, row.householdId), eq(mediaAssets.status, "ready"),
      or(isNull(mediaAssets.byteSize), eq(mediaAssets.byteSize, bytes.byteLength)),
      or(isNull(mediaAssets.checksum), eq(mediaAssets.checksum, checksum)),
    ));
    const canonical = await db.select({ byteSize: mediaAssets.byteSize, checksum: mediaAssets.checksum, status: mediaAssets.status })
      .from(mediaAssets).where(and(eq(mediaAssets.id, row.id), eq(mediaAssets.householdId, row.householdId))).get();
    if (canonical?.status !== "ready" || canonical.byteSize !== bytes.byteLength || canonical.checksum !== checksum) continue;
    await db.batch([
      db.insert(householdStorageReservations).values({ id: `storage:${row.id}`, householdId: row.householdId, mediaAssetId: row.id, byteSize: bytes.byteLength, status: "reserved", createdAt: now, updatedAt: now }).onConflictDoNothing(),
      db.update(householdStorageReservations).set({ status: "committed", updatedAt: now }).where(and(eq(householdStorageReservations.mediaAssetId, row.id), eq(householdStorageReservations.householdId, row.householdId), eq(householdStorageReservations.status, "reserved"))),
      db.insert(task2cMediaIntegrity).values({ mediaAssetId: row.id, byteSize: bytes.byteLength, checksum, verifiedAt: now }).onConflictDoNothing(),
    ] as unknown as Parameters<typeof db.batch>[0]);
    processed += 1;
  }
  const unresolved = await db.select({ value: sql<number>`count(*)` }).from(mediaAssets).where(and(eq(mediaAssets.status, "ready"), unresolvedWhere)).get();
  const unresolvedReadyMedia = unresolved?.value || 0;
  await db.insert(task2cActivationState).values({ id: "storage", status: unresolvedReadyMedia === 0 ? "ready" : "pending", unresolvedReadyMedia, checkedAt: new Date() }).onConflictDoUpdate({ target: task2cActivationState.id, set: { status: unresolvedReadyMedia === 0 ? "ready" : "pending", unresolvedReadyMedia, checkedAt: new Date() } });
  return { processed, unresolvedReadyMedia, ready: unresolvedReadyMedia === 0 };
}
