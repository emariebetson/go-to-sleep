import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { playlists } from "@/db/schema";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { parsePlaylistInput } from "@/lib/api-v1-input";
import { assertSameOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

const publicPlaylist = {
  id: playlists.id,
  name: playlists.name,
  private: playlists.private,
  createdAt: playlists.createdAt,
  updatedAt: playlists.updatedAt,
};

export async function GET(request: Request) {
  if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
  try {
    const { householdId } = await requireHouseholdContext(request, "playlist:read");
    const records = await getDb().select(publicPlaylist).from(playlists)
      .where(and(eq(playlists.householdId, householdId), isNull(playlists.deletedAt)))
      .orderBy(desc(playlists.updatedAt)).all();
    return jsonNoStore({ apiVersion: "v1", playlists: records });
  } catch (error) {
    return apiV1Failure(error, "Playlists could not be loaded.");
  }
}

export async function POST(request: Request) {
  if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
  try {
    assertSameOrigin(request);
    const { householdId, user } = await requireHouseholdContext(request, "playlist:write");
    let input;
    try { input = parsePlaylistInput(await readJsonObject(request, 2_000)); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    const now = new Date();
    const inserted = await getDb().insert(playlists).values({
      id: `playlist:${householdId}:${input.requestId}`,
      householdId,
      createdByUserId: user.userId,
      name: input.name,
      private: true,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning(publicPlaylist).get();
    if (inserted) return jsonNoStore({ apiVersion: "v1", playlist: inserted }, { status: 201 });
    const existing = await getDb().select(publicPlaylist).from(playlists)
      .where(and(eq(playlists.id, `playlist:${householdId}:${input.requestId}`), eq(playlists.householdId, householdId), isNull(playlists.deletedAt))).get();
    if (!existing || existing.name !== input.name) return jsonNoStore({ error: "That request ID is already associated with different playlist data." }, { status: 409 });
    return jsonNoStore({ apiVersion: "v1", playlist: existing, duplicate: true });
  } catch (error) {
    return apiV1Failure(error, "Playlist could not be created.");
  }
}
