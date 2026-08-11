import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { playlists } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { householdId } = await requireHouseholdContext(request, "playlist:write");
    const { id } = await context.params;
    const now = new Date();
    const removed = await getDb().update(playlists).set({ deletedAt: now, updatedAt: now }).where(and(
      eq(playlists.id, id), eq(playlists.householdId, householdId), isNull(playlists.deletedAt),
    )).returning({ deletedAt: playlists.deletedAt }).get();
    if (!removed) {
      const duplicate = await getDb().select({ id: playlists.id }).from(playlists).where(and(eq(playlists.id, id), eq(playlists.householdId, householdId))).get();
      if (!duplicate) return jsonNoStore({ error: "Playlist not found." }, { status: 404 });
      return jsonNoStore({ deleted: true, duplicate: true });
    }
    return jsonNoStore({ deleted: true });
  } catch (error) {
    return apiV1Failure(error, "Playlist could not be deleted.");
  }
}
