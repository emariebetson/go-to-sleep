import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { householdExports } from "@/db/schema";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { jsonNoStore } from "@/lib/http";
import type { ExportBucket } from "@/lib/nearsleep-export";
import { sha256Hex } from "@/lib/nearsleep-library";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
    const { householdId, user, role } = await requireHouseholdContext(request, "household:write");
    if (role !== "owner") return jsonNoStore({ error: "Export not found." }, { status: 404 });
    const { id } = await context.params;
    const record = await getDb().select().from(householdExports).where(and(
      eq(householdExports.id, id), eq(householdExports.householdId, householdId), eq(householdExports.requestedByUserId, user.userId),
    )).get();
    if (!record || record.status !== "succeeded" || !record.manifestStorageKey || !record.manifestByteSize || !record.manifestChecksum) return jsonNoStore({ error: "Export not found." }, { status: 404 });
    if (record.expiresAt.getTime() <= Date.now()) return jsonNoStore({ error: "This export has expired." }, { status: 410 });
    const bucket = (env as unknown as { AUDIO?: ExportBucket }).AUDIO;
    if (!bucket) return jsonNoStore({ error: "Private export storage is unavailable." }, { status: 503 });
    const metadata = await bucket.head(record.manifestStorageKey);
    if (!metadata || metadata.size !== record.manifestByteSize || metadata.customMetadata?.checksum !== record.manifestChecksum) return jsonNoStore({ error: "Export requires reconciliation." }, { status: 503 });
    const object = await bucket.get(record.manifestStorageKey);
    if (!object) return jsonNoStore({ error: "Export requires reconciliation." }, { status: 503 });
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength !== record.manifestByteSize || await sha256Hex(bytes) !== record.manifestChecksum) return jsonNoStore({ error: "Export requires reconciliation." }, { status: 503 });
    const safeId = id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120) || "export";
    return new Response(bytes, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/json",
        "content-disposition": `attachment; filename="nearyou-household-${safeId}.json"`,
        "x-nearyou-sha256": record.manifestChecksum,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: "Export download is unavailable." }, { status: 500 });
  }
}
