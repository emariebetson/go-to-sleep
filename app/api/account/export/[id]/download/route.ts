import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { householdExportDownloadConfirmations, householdExportMetadataPages, householdExportParts, householdExports } from "@/db/schema";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

type Artifact = { kind: "manifest" | "metadata" | "part"; id: string; sha256: string };

function parseArtifacts(value: unknown): Artifact[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_001) throw new Error("The complete export artifact receipt is required.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("The export artifact receipt is invalid.");
    const item = entry as Record<string, unknown>;
    const kind = String(item.kind || "");
    const id = String(item.id || "");
    const sha256 = String(item.sha256 || "").toLowerCase();
    if (!(["manifest", "metadata", "part"] as string[]).includes(kind) || !id || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("The export artifact receipt is invalid.");
    return { kind: kind as Artifact["kind"], id, sha256 };
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { householdId, user, role } = await requireHouseholdContext(request, "household:write");
    if (role !== "owner") return jsonNoStore({ error: "Export not found." }, { status: 404 });
    const { id } = await context.params;
    const artifacts = parseArtifacts((await readJsonObject(request, 1_000_000)).artifacts);
    const db = getDb();
    const record = await db.select().from(householdExports).where(and(
      eq(householdExports.id, id), eq(householdExports.householdId, householdId), eq(householdExports.requestedByUserId, user.userId), eq(householdExports.status, "succeeded"),
    )).get();
    if (!record?.manifestChecksum || record.expiresAt.getTime() <= Date.now()) return jsonNoStore({ error: "Export not found." }, { status: 404 });
    const [pages, parts] = await Promise.all([
      db.select({ id: householdExportMetadataPages.position, checksum: householdExportMetadataPages.checksum }).from(householdExportMetadataPages).where(and(eq(householdExportMetadataPages.exportId, id), eq(householdExportMetadataPages.status, "ready"))).all(),
      db.select({ id: householdExportParts.id, checksum: householdExportParts.checksum }).from(householdExportParts).where(and(eq(householdExportParts.exportId, id), eq(householdExportParts.status, "copied"))).all(),
    ]);
    const expected = new Map<string, string>([["manifest:manifest", record.manifestChecksum], ...pages.map((page) => [`metadata:${page.id}`, page.checksum] as const), ...parts.map((part) => [`part:${part.id}`, part.checksum || ""] as const)]);
    const provided = new Map(artifacts.map((artifact) => [`${artifact.kind}:${artifact.id}`, artifact.sha256]));
    if (provided.size !== artifacts.length || provided.size !== expected.size || [...expected].some(([key, checksum]) => provided.get(key) !== checksum)) return jsonNoStore({ error: "Every checksummed export file must be downloaded and verified before confirmation." }, { status: 409 });
    const confirmedAt = new Date();
    await db.insert(householdExportDownloadConfirmations).values({ exportId: id, userId: user.userId, manifestChecksum: record.manifestChecksum, artifactCount: expected.size, confirmedAt })
      .onConflictDoUpdate({ target: householdExportDownloadConfirmations.exportId, set: { userId: user.userId, manifestChecksum: record.manifestChecksum, artifactCount: expected.size, confirmedAt } });
    return jsonNoStore({ confirmed: true, artifactCount: expected.size, confirmedAt });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: error instanceof Error ? error.message : "Export download confirmation failed." }, { status: 400 });
  }
}
