import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { householdExportMetadataPages, householdExports } from "@/db/schema";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";
import type { ExportBucket } from "@/lib/nearsleep-export";
import { sha256Hex } from "@/lib/nearsleep-library";

export async function GET(request: Request, context: { params: Promise<{ id: string; position: string }> }) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return new Response("Not found", { status: 404 });
    const { householdId, user, role } = await requireHouseholdContext(request, "household:write");
    if (role !== "owner") return new Response("Not found", { status: 404 });
    const { id, position } = await context.params;
    if (!/^\d{1,9}$/.test(position)) return new Response("Not found", { status: 404 });
    const page = await getDb().select({ key: householdExportMetadataPages.storageKey, checksum: householdExportMetadataPages.checksum, byteSize: householdExportMetadataPages.byteSize, expiresAt: householdExportMetadataPages.expiresAt })
      .from(householdExportMetadataPages).innerJoin(householdExports, and(
        eq(householdExportMetadataPages.exportId, householdExports.id),
        eq(householdExports.householdId, householdId),
        eq(householdExports.requestedByUserId, user.userId),
        eq(householdExports.status, "succeeded"),
      )).where(and(
        eq(householdExportMetadataPages.exportId, id),
        eq(householdExportMetadataPages.position, Number(position)),
        eq(householdExportMetadataPages.status, "ready"),
      )).get();
    if (!page) return new Response("Not found", { status: 404 });
    if (page.expiresAt.getTime() <= Date.now()) return new Response("Expired", { status: 410 });
    const bucket = (env as unknown as { AUDIO?: ExportBucket }).AUDIO;
    if (!bucket) return new Response("Private export storage is unavailable", { status: 503 });
    const metadata = await bucket.head(page.key);
    if (!metadata || metadata.size !== page.byteSize || metadata.customMetadata?.checksum !== page.checksum) return new Response("Export requires reconciliation", { status: 503 });
    const object = await bucket.get(page.key);
    if (!object) return new Response("Export requires reconciliation", { status: 503 });
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== page.byteSize || await sha256Hex(bytes) !== page.checksum) return new Response("Export requires reconciliation", { status: 503 });
    return new Response(bytes, { headers: {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="metadata-${String(Number(position)).padStart(8, "0")}.json"`,
      "content-type": "application/json",
      "x-nearyou-sha256": page.checksum,
    } });
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response("Export download is unavailable", { status: 500 });
  }
}
