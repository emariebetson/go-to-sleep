import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { childProfiles, voices } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { jsonNoStore } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

export async function GET(request: Request) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
    const { householdId } = await requireHouseholdContext(request, "playlist:read");
    const [children, voiceRecords] = await Promise.all([
      getDb().select({ id: childProfiles.id, label: childProfiles.nickname }).from(childProfiles)
        .where(and(eq(childProfiles.householdId, householdId), isNull(childProfiles.archivedAt))).orderBy(asc(childProfiles.nickname)).all(),
      getDb().select({ id: voices.id, label: voices.name }).from(voices)
        .where(and(eq(voices.householdId, householdId), eq(voices.status, "ready"), isNull(voices.deletedAt))).orderBy(asc(voices.name)).all(),
    ]);
    return jsonNoStore({ children, voices: voiceRecords });
  } catch (error) {
    return apiV1Failure(error, "Library filters could not be loaded.");
  }
}
