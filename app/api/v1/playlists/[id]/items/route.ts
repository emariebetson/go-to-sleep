import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { mediaAssets, playlistItems, playlists, sleepSessions } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

function enabled() { return nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env)); }

function parseItem(body: Record<string, unknown>) {
  const requestId = String(body.requestId || "").trim().toLowerCase();
  const mediaAssetId = String(body.mediaAssetId || "").trim();
  const position = Number(body.position);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) throw new Error("A stable requestId is required.");
  if (!mediaAssetId || mediaAssetId.length > 200) throw new Error("mediaAssetId is required.");
  if (!Number.isInteger(position) || position < 0 || position > 249) throw new Error("position must be an integer from 0 through 249.");
  return { requestId, mediaAssetId, position };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!enabled()) return jsonNoStore({ error: "Not found." }, { status: 404 });
    const { householdId } = await requireHouseholdContext(request, "playlist:read");
    const { id } = await context.params;
    const playlist = await getDb().select({ id: playlists.id, name: playlists.name }).from(playlists).where(and(
      eq(playlists.id, id), eq(playlists.householdId, householdId), isNull(playlists.deletedAt),
    )).get();
    if (!playlist) return jsonNoStore({ error: "Playlist not found." }, { status: 404 });
    const items = await getDb().select({
      id: playlistItems.id,
      position: playlistItems.position,
      mediaAssetId: mediaAssets.id,
      sessionId: sleepSessions.id,
      title: sleepSessions.title,
    }).from(playlistItems).innerJoin(mediaAssets, and(
      eq(playlistItems.mediaAssetId, mediaAssets.id), eq(mediaAssets.householdId, householdId), eq(mediaAssets.status, "ready"),
      eq(mediaAssets.private, true), isNull(mediaAssets.deletedAt),
    )).innerJoin(sleepSessions, and(
      eq(sleepSessions.mediaAssetId, mediaAssets.id), eq(sleepSessions.householdId, householdId), eq(sleepSessions.status, "ready"), eq(sleepSessions.deletionStatus, "active"),
    )).where(eq(playlistItems.playlistId, id)).orderBy(asc(playlistItems.position)).all();
    return jsonNoStore({ playlist, items });
  } catch (error) {
    return apiV1Failure(error, "Playlist items could not be loaded.");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!enabled()) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { householdId } = await requireHouseholdContext(request, "playlist:write");
    const { id } = await context.params;
    let input;
    try { input = parseItem(await readJsonObject(request, 2_000)); } catch (error) {
      return jsonNoStore({ error: error instanceof Error ? error.message : "Playlist item is invalid." }, { status: 400 });
    }
    const playlist = await getDb().select({ id: playlists.id }).from(playlists).where(and(
      eq(playlists.id, id), eq(playlists.householdId, householdId), isNull(playlists.deletedAt),
    )).get();
    if (!playlist) return jsonNoStore({ error: "Playlist not found." }, { status: 404 });
    const now = new Date();
    try {
      const item = await getDb().insert(playlistItems).values({
        id: `playlist-item:${id}:${input.requestId}`,
        playlistId: id,
        mediaAssetId: input.mediaAssetId,
        position: input.position,
        createdAt: now,
      }).onConflictDoNothing().returning({ id: playlistItems.id, mediaAssetId: playlistItems.mediaAssetId, position: playlistItems.position }).get();
      if (item) return jsonNoStore({ item }, { status: 201 });
      const existing = await getDb().select({ id: playlistItems.id, mediaAssetId: playlistItems.mediaAssetId, position: playlistItems.position })
        .from(playlistItems).where(and(eq(playlistItems.id, `playlist-item:${id}:${input.requestId}`), eq(playlistItems.playlistId, id))).get();
      if (!existing || existing.mediaAssetId !== input.mediaAssetId || existing.position !== input.position) {
        return jsonNoStore({ error: "That request ID conflicts with another playlist item." }, { status: 409 });
      }
      return jsonNoStore({ item: existing, duplicate: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      if (detail.includes("household_mismatch")) return jsonNoStore({ error: "Media not found." }, { status: 404 });
      if (detail.includes("limit_reached")) return jsonNoStore({ error: "This playlist has reached the household plan limit." }, { status: 409 });
      if (detail.includes("UNIQUE")) return jsonNoStore({ error: "That media or position is already in the playlist." }, { status: 409 });
      throw error;
    }
  } catch (error) {
    return apiV1Failure(error, "Playlist item could not be added.");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!enabled()) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { householdId } = await requireHouseholdContext(request, "playlist:write");
    const { id } = await context.params;
    const itemId = new URL(request.url).searchParams.get("itemId")?.trim();
    if (!itemId) return jsonNoStore({ error: "itemId is required." }, { status: 400 });
    const playlist = await getDb().select({ id: playlists.id }).from(playlists).where(and(
      eq(playlists.id, id), eq(playlists.householdId, householdId), isNull(playlists.deletedAt),
    )).get();
    if (!playlist) return jsonNoStore({ error: "Playlist item not found." }, { status: 404 });
    const removed = await getDb().delete(playlistItems).where(and(
      eq(playlistItems.id, itemId),
      eq(playlistItems.playlistId, id),
    )).returning({ id: playlistItems.id }).get();
    if (!removed) return jsonNoStore({ deleted: true, duplicate: true });
    return jsonNoStore({ deleted: true });
  } catch (error) {
    return apiV1Failure(error, "Playlist item could not be removed.");
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!enabled()) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { householdId } = await requireHouseholdContext(request, "playlist:write");
    const { id } = await context.params;
    const body = await readJsonObject(request, 20_000);
    const order = Array.isArray(body.itemIds) ? body.itemIds.map((value) => String(value).trim()) : [];
    if (order.length > 250 || new Set(order).size !== order.length || order.some((value) => !value || value.length > 300)) return jsonNoStore({ error: "itemIds must be a unique ordered list." }, { status: 400 });
    const db = getDb();
    const playlist = await db.select({ id: playlists.id }).from(playlists).where(and(eq(playlists.id, id), eq(playlists.householdId, householdId), isNull(playlists.deletedAt))).get();
    if (!playlist) return jsonNoStore({ error: "Playlist not found." }, { status: 404 });
    const current = await db.select({ id: playlistItems.id, position: playlistItems.position }).from(playlistItems).where(eq(playlistItems.playlistId, id)).orderBy(asc(playlistItems.position)).all();
    if (current.length !== order.length || current.some((item) => !order.includes(item.id))) return jsonNoStore({ error: "Playlist changed; reload before reordering." }, { status: 409 });
    if (current.every((item, position) => order[position] === item.id && item.position === position)) return jsonNoStore({ reordered: true, duplicate: true });
    const now = new Date();
    await db.batch([
      ...current.map((item, index) => db.update(playlistItems).set({ position: 1000 + index }).where(and(eq(playlistItems.id, item.id), eq(playlistItems.playlistId, id)))),
      ...order.map((itemId, position) => db.update(playlistItems).set({ position }).where(and(eq(playlistItems.id, itemId), eq(playlistItems.playlistId, id)))),
      db.update(playlists).set({ updatedAt: now }).where(and(eq(playlists.id, id), eq(playlists.householdId, householdId))),
    ] as unknown as Parameters<typeof db.batch>[0]);
    return jsonNoStore({ reordered: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiV1Failure(error, "Playlist could not be reordered.");
  }
}
