import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { bedtimeQueueItems, mediaAssets, sleepSessions } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

function enabled() { return nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env)); }

function parseQueueItem(body: Record<string, unknown>) {
  const requestId = String(body.requestId || "").trim().toLowerCase();
  const sessionId = String(body.sessionId || "").trim();
  const position = Number(body.position);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) throw new Error("A stable requestId is required.");
  if (!sessionId || sessionId.length > 200) throw new Error("sessionId is required.");
  if (!Number.isInteger(position) || position < 0 || position > 99) throw new Error("position must be an integer from 0 through 99.");
  return { requestId, sessionId, position };
}

export async function GET(request: Request) {
  try {
    if (!enabled()) return jsonNoStore({ error: "Not found." }, { status: 404 });
    const { householdId } = await requireHouseholdContext(request, "playlist:read");
    const items = await getDb().select({
      id: bedtimeQueueItems.id,
      sessionId: sleepSessions.id,
      title: sleepSessions.title,
      position: bedtimeQueueItems.position,
      status: bedtimeQueueItems.status,
    }).from(bedtimeQueueItems).innerJoin(sleepSessions, and(
      eq(bedtimeQueueItems.sessionId, sleepSessions.id),
      eq(sleepSessions.householdId, householdId),
      eq(sleepSessions.status, "ready"),
      eq(sleepSessions.deletionStatus, "active"),
    )).innerJoin(mediaAssets, and(
      eq(sleepSessions.mediaAssetId, mediaAssets.id),
      eq(mediaAssets.householdId, householdId),
      eq(mediaAssets.status, "ready"),
      eq(mediaAssets.private, true),
      isNull(mediaAssets.deletedAt),
    )).where(and(
      eq(bedtimeQueueItems.householdId, householdId),
      inArray(bedtimeQueueItems.status, ["queued", "playing"]),
    )).orderBy(asc(bedtimeQueueItems.position)).all();
    return jsonNoStore({ items });
  } catch (error) {
    return apiV1Failure(error, "The bedtime queue could not be loaded.");
  }
}

export async function POST(request: Request) {
  try {
    if (!enabled()) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { householdId, user } = await requireHouseholdContext(request, "playlist:write");
    let input;
    try { input = parseQueueItem(await readJsonObject(request, 2_000)); } catch (error) {
      return jsonNoStore({ error: error instanceof Error ? error.message : "Queue item is invalid." }, { status: 400 });
    }
    const now = new Date();
    try {
      const item = await getDb().insert(bedtimeQueueItems).values({
        id: `queue:${householdId}:${input.requestId}`,
        householdId,
        queuedByUserId: user.userId,
        sessionId: input.sessionId,
        position: input.position,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().returning({ id: bedtimeQueueItems.id, sessionId: bedtimeQueueItems.sessionId, position: bedtimeQueueItems.position }).get();
      if (item) return jsonNoStore({ item }, { status: 201 });
      const existing = await getDb().select({ id: bedtimeQueueItems.id, sessionId: bedtimeQueueItems.sessionId, position: bedtimeQueueItems.position })
        .from(bedtimeQueueItems).where(and(eq(bedtimeQueueItems.id, `queue:${householdId}:${input.requestId}`), eq(bedtimeQueueItems.householdId, householdId))).get();
      if (!existing || existing.sessionId !== input.sessionId || existing.position !== input.position) return jsonNoStore({ error: "That request ID conflicts with another queue item." }, { status: 409 });
      return jsonNoStore({ item: existing, duplicate: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      if (detail.includes("queue_session_unavailable")) return jsonNoStore({ error: "Session not found." }, { status: 404 });
      if (detail.includes("limit_reached") || detail.includes("UNIQUE")) return jsonNoStore({ error: "The bedtime queue has reached its limit or position is occupied." }, { status: 409 });
      throw error;
    }
  } catch (error) {
    return apiV1Failure(error, "The session could not be queued.");
  }
}

export async function DELETE(request: Request) {
  try {
    if (!enabled()) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { householdId } = await requireHouseholdContext(request, "playlist:write");
    const itemId = new URL(request.url).searchParams.get("itemId")?.trim();
    if (!itemId) return jsonNoStore({ error: "itemId is required." }, { status: 400 });
    const removed = await getDb().update(bedtimeQueueItems).set({ status: "removed", updatedAt: new Date() }).where(and(
      eq(bedtimeQueueItems.id, itemId), eq(bedtimeQueueItems.householdId, householdId), inArray(bedtimeQueueItems.status, ["queued", "playing"]),
    )).returning({ id: bedtimeQueueItems.id }).get();
    if (!removed) {
      const duplicate = await getDb().select({ id: bedtimeQueueItems.id }).from(bedtimeQueueItems).where(and(
        eq(bedtimeQueueItems.id, itemId), eq(bedtimeQueueItems.householdId, householdId), inArray(bedtimeQueueItems.status, ["removed", "played"]),
      )).get();
      if (!duplicate) return jsonNoStore({ error: "Queue item not found." }, { status: 404 });
      return jsonNoStore({ removed: true, duplicate: true });
    }
    return jsonNoStore({ removed: true });
  } catch (error) {
    return apiV1Failure(error, "The queue item could not be removed.");
  }
}

export async function PATCH(request: Request) {
  try {
    if (!enabled()) return jsonNoStore({ error: "Not found." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { householdId } = await requireHouseholdContext(request, "playlist:write");
    const body = await readJsonObject(request, 10_000);
    const order = Array.isArray(body.itemIds) ? body.itemIds.map((value) => String(value).trim()) : [];
    const playingItemId = body.playingItemId === null ? null : String(body.playingItemId || "").trim();
    if (order.length > 100 || new Set(order).size !== order.length || order.some((value) => !value || value.length > 300) || (playingItemId !== null && !order.includes(playingItemId))) {
      return jsonNoStore({ error: "itemIds and playingItemId must describe the complete active queue." }, { status: 400 });
    }
    const db = getDb();
    const current = await db.select({ id: bedtimeQueueItems.id, position: bedtimeQueueItems.position, status: bedtimeQueueItems.status }).from(bedtimeQueueItems).where(and(
      eq(bedtimeQueueItems.householdId, householdId), inArray(bedtimeQueueItems.status, ["queued", "playing"]),
    )).orderBy(asc(bedtimeQueueItems.position)).all();
    if (current.length !== order.length || current.some((item) => !order.includes(item.id))) return jsonNoStore({ error: "Queue changed; reload before reordering." }, { status: 409 });
    if (current.every((item, position) => order[position] === item.id && item.position === position && item.status === (item.id === playingItemId ? "playing" : "queued"))) return jsonNoStore({ reordered: true, duplicate: true });
    const now = new Date();
    await db.batch([
      ...current.map((item, index) => db.update(bedtimeQueueItems).set({ position: 1000 + index, status: "queued", updatedAt: now }).where(and(eq(bedtimeQueueItems.id, item.id), eq(bedtimeQueueItems.householdId, householdId)))),
      ...order.map((itemId, position) => db.update(bedtimeQueueItems).set({ position, status: itemId === playingItemId ? "playing" : "queued", updatedAt: now }).where(and(eq(bedtimeQueueItems.id, itemId), eq(bedtimeQueueItems.householdId, householdId)))),
    ] as unknown as Parameters<typeof db.batch>[0]);
    return jsonNoStore({ reordered: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiV1Failure(error, "The bedtime queue could not be reordered.");
  }
}
