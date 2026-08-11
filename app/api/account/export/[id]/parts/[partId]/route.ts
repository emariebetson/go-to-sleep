import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { householdExportParts, householdExports } from "@/db/schema";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { parseByteRange } from "@/lib/http-range";
import type { ExportBucket } from "@/lib/nearsleep-export";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

export async function GET(request: Request, context: { params: Promise<{ id: string; partId: string }> }) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return new Response("Not found", { status: 404 });
    const { householdId, user, role } = await requireHouseholdContext(request, "household:write");
    if (role !== "owner") return new Response("Not found", { status: 404 });
    const { id, partId } = await context.params;
    const part = await getDb().select({ key: householdExportParts.exportStorageKey, contentType: householdExportParts.contentType, byteSize: householdExportParts.byteSize, checksum: householdExportParts.checksum, expiresAt: householdExportParts.expiresAt })
      .from(householdExportParts).innerJoin(householdExports, and(
        eq(householdExportParts.exportId, householdExports.id), eq(householdExports.householdId, householdId), eq(householdExports.requestedByUserId, user.userId), eq(householdExports.status, "succeeded"),
      )).where(and(eq(householdExportParts.id, partId), eq(householdExportParts.exportId, id), eq(householdExportParts.status, "copied"))).get();
    if (!part) return new Response("Not found", { status: 404 });
    if (part.expiresAt.getTime() <= Date.now()) return new Response("Expired", { status: 410 });
    const bucket = (env as unknown as { AUDIO?: ExportBucket }).AUDIO;
    if (!bucket) return new Response("Private export storage is unavailable", { status: 503 });
    const metadata = await bucket.head(part.key);
    if (!metadata || metadata.size !== part.byteSize || metadata.customMetadata?.checksum !== part.checksum) return new Response("Export requires reconciliation", { status: 503 });
    const range = parseByteRange(request.headers.get("range"), metadata.size);
    if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "content-range": `bytes */${metadata.size}` } });
    const object = await bucket.get(part.key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
    if (!object?.body) return new Response("Export requires reconciliation", { status: 503 });
    const headers = new Headers({
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${partId.replace(/[^A-Za-z0-9_-]/g, "-")}.mp3"`,
      "content-length": String(range ? range.end - range.start + 1 : metadata.size),
      "content-type": part.contentType,
      "vary": "range",
      "x-nearyou-sha256": part.checksum || "",
    });
    if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${metadata.size}`);
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response("Export download is unavailable", { status: 500 });
  }
}
