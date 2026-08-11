import { env } from "cloudflare:workers";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { householdExportDownloadConfirmations, householdExports } from "@/db/schema";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { advanceHouseholdExport, claimHouseholdExport, publicExport, type ExportBucket } from "@/lib/nearsleep-export";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

function bucket() { return (env as unknown as { AUDIO?: ExportBucket }).AUDIO; }

function requestId(body: Record<string, unknown>) {
  const value = String(body.requestId || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error("A stable requestId is required.");
  return value;
}

export async function GET(request: Request) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
    const { householdId, user, role } = await requireHouseholdContext(request, "household:write");
    if (role !== "owner") return jsonNoStore({ error: "Only the household owner can export this household." }, { status: 403 });
    const records = await getDb().select().from(householdExports).where(and(eq(householdExports.householdId, householdId), eq(householdExports.requestedByUserId, user.userId)))
      .orderBy(desc(householdExports.createdAt)).limit(20).all();
    const confirmations = records.length ? await getDb().select({ exportId: householdExportDownloadConfirmations.exportId }).from(householdExportDownloadConfirmations).where(inArray(householdExportDownloadConfirmations.exportId, records.map(({ id }) => id))).all() : [];
    const confirmed = new Set(confirmations.map(({ exportId }) => exportId));
    return jsonNoStore({ exports: records.map((record) => publicExport(record, confirmed.has(record.id))) });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: "Household export status is unavailable." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const storage = bucket();
    if (!storage) return jsonNoStore({ error: "Private export storage is unavailable." }, { status: 503 });
    const { householdId, user, role } = await requireHouseholdContext(request, "household:write");
    if (role !== "owner") return jsonNoStore({ error: "Only the household owner can export this household." }, { status: 403 });
    let id;
    try { id = requestId(await readJsonObject(request, 2_000)); } catch (error) {
      return error instanceof Response ? error : jsonNoStore({ error: error instanceof Error ? error.message : "Export request is invalid." }, { status: 400 });
    }
    let record;
    try { record = await claimHouseholdExport({ requestId: id, householdId, userId: user.userId }); } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "export_idempotency_conflict") return jsonNoStore({ error: "That request ID is associated with different export data." }, { status: 409 });
      if (code === "export_live_exists") return jsonNoStore({ error: "This household already has a live export. Retry or download that export before starting another." }, { status: 409 });
      if (code === "export_media_reconciliation_required") return jsonNoStore({ error: "Media inventory requires reconciliation before it can be exported." }, { status: 503 });
      if (code === "export_inventory_too_large") return jsonNoStore({ error: "Household metadata exceeds a fail-loud export safety boundary. No partial export was created; contact support for a complete assisted export." }, { status: 409 });
      throw error;
    }
    record = await advanceHouseholdExport({ exportId: record.id, householdId, userId: user.userId, bucket: storage }) || record;
    return jsonNoStore({ export: publicExport(record) }, { status: record.status === "succeeded" ? 201 : 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Household export failed", error);
    return jsonNoStore({ error: "Household export needs attention and can be retried safely." }, { status: 500 });
  }
}
