import { env } from "cloudflare:workers";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { householdExportDownloadConfirmations, householdExportMetadataPages, householdExportParts, householdExports } from "@/db/schema";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import type { ExportBucket } from "@/lib/nearsleep-export";
import { sha256Hex } from "@/lib/nearsleep-library";
import { tarHeader, tarPadding } from "@/lib/nearsleep-tar";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

type ArchiveEntry = { name: string; key: string; size: number; checksum: string };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return new Response("Not found", { status: 404 });
    const { householdId, user, role } = await requireHouseholdContext(request, "household:write");
    if (role !== "owner") return new Response("Not found", { status: 404 });
    const { id } = await context.params;
    const db = getDb();
    const record = await db.select().from(householdExports).where(and(eq(householdExports.id, id), eq(householdExports.householdId, householdId), eq(householdExports.requestedByUserId, user.userId), eq(householdExports.status, "succeeded"))).get();
    if (!record?.manifestStorageKey || !record.manifestByteSize || !record.manifestChecksum || record.expiresAt.getTime() <= Date.now()) return new Response("Export not found", { status: 404 });
    const manifestChecksum = record.manifestChecksum;
    const [pages, parts] = await Promise.all([
      db.select({ position: householdExportMetadataPages.position, key: householdExportMetadataPages.storageKey, size: householdExportMetadataPages.byteSize, checksum: householdExportMetadataPages.checksum }).from(householdExportMetadataPages).where(and(eq(householdExportMetadataPages.exportId, id), eq(householdExportMetadataPages.status, "ready"))).orderBy(asc(householdExportMetadataPages.position)).all(),
      db.select({ id: householdExportParts.id, key: householdExportParts.exportStorageKey, size: householdExportParts.byteSize, checksum: householdExportParts.checksum }).from(householdExportParts).where(and(eq(householdExportParts.exportId, id), eq(householdExportParts.status, "copied"))).orderBy(asc(householdExportParts.id)).all(),
    ]);
    if (parts.some((part) => !part.size || !part.checksum)) return new Response("Export requires reconciliation", { status: 503 });
    const entries: ArchiveEntry[] = [
      { name: "manifest.json", key: record.manifestStorageKey, size: record.manifestByteSize, checksum: record.manifestChecksum },
      ...pages.map((page) => ({ name: `metadata-${String(page.position).padStart(8, "0")}.json`, key: page.key, size: page.size, checksum: page.checksum })),
      ...parts.map((part, index) => ({ name: `media-${String(index).padStart(8, "0")}.mp3`, key: part.key, size: part.size!, checksum: part.checksum! })),
    ];
    const bucket = (env as unknown as { AUDIO?: ExportBucket }).AUDIO;
    if (!bucket) return new Response("Private export storage is unavailable", { status: 503 });
    const requireActiveExport = async () => {
      const active = await db.select({ id: householdExports.id }).from(householdExports).where(and(
        eq(householdExports.id, id), eq(householdExports.householdId, householdId), eq(householdExports.requestedByUserId, user.userId),
        eq(householdExports.status, "succeeded"), eq(householdExports.manifestChecksum, manifestChecksum),
      )).get();
      if (!active || record.expiresAt.getTime() <= Date.now()) throw new Error("export_archive_invalidated");
    };
    async function* archive() {
      for (const entry of entries) {
        await requireActiveExport();
        const head = await bucket!.head(entry.key);
        if (!head || head.size !== entry.size || head.customMetadata?.checksum !== entry.checksum) throw new Error("export_archive_reconciliation_required");
        const object = await bucket!.get(entry.key);
        if (!object) throw new Error("export_archive_reconciliation_required");
        const bytes = await object.arrayBuffer();
        if (bytes.byteLength !== entry.size || await sha256Hex(bytes) !== entry.checksum) throw new Error(`export_archive_reconciliation_required:${entry.name}`);
        yield tarHeader(entry.name, entry.size); yield new Uint8Array(bytes); const padding = tarPadding(entry.size); if (padding.byteLength) yield padding;
      }
      yield new Uint8Array(1024);
      await requireActiveExport();
      const confirmedAt = new Date();
      await db.insert(householdExportDownloadConfirmations).values({ exportId: id, userId: user.userId, manifestChecksum, artifactCount: entries.length, confirmedAt })
        .onConflictDoUpdate({ target: householdExportDownloadConfirmations.exportId, set: { userId: user.userId, manifestChecksum, artifactCount: entries.length, confirmedAt } });
    }
    const iterator = archive();
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) { try { const result = await iterator.next(); if (result.done) controller.close(); else controller.enqueue(result.value); } catch (error) { controller.error(error); } }, async cancel() { await iterator.return?.(); } });
    const safeId = id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
    return new Response(stream, { headers: { "cache-control": "private, no-store", "content-type": "application/x-tar", "content-disposition": `attachment; filename="nearyou-household-${safeId}.tar"` } });
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response("Export archive is unavailable", { status: 500 });
  }
}
