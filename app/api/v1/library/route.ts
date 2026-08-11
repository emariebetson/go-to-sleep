import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/db";
import { mediaAssets, sleepSessions } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { jsonNoStore } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";
import { decodeLibraryCursor, encodeLibraryCursor } from "@/lib/nearsleep-library";

export async function GET(request: Request) {
  try {
    if (!nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) return jsonNoStore({ error: "Not found." }, { status: 404 });
    const { householdId } = await requireHouseholdContext(request, "playlist:read");
    const search = new URL(request.url).searchParams;
    const childProfileId = search.get("childProfileId")?.trim();
    const voiceId = search.get("voiceId")?.trim();
    const favorite = search.get("favorite");
    const cursorValue = search.get("cursor");
    let cursor: ReturnType<typeof decodeLibraryCursor> | null = null;
    try { cursor = cursorValue ? decodeLibraryCursor(cursorValue) : null; } catch {
      return jsonNoStore({ error: "cursor is invalid." }, { status: 400 });
    }
    const limit = Math.min(100, Math.max(1, Number(search.get("limit") || 50)));
    if (favorite !== null && favorite !== "true" && favorite !== "false") {
      return jsonNoStore({ error: "favorite must be true or false." }, { status: 400 });
    }
    if (!Number.isSafeInteger(limit)) {
      return jsonNoStore({ error: "limit is invalid." }, { status: 400 });
    }
    const sessions = await getDb().select({
      sessionId: sleepSessions.id,
      title: sleepSessions.title,
      script: sleepSessions.script,
      childProfileId: mediaAssets.childProfileId,
      voiceId: sleepSessions.voiceId,
      narrationKind: sleepSessions.narrationKind,
      theme: sleepSessions.theme,
      backgroundSound: sleepSessions.backgroundSound,
      frequencyLayers: sleepSessions.frequencyLayers,
      durationMinutes: sleepSessions.durationMinutes,
      favorite: sleepSessions.favorite,
      repeatMinutes: sleepSessions.repeatMinutes,
      mediaAssetId: mediaAssets.id,
      createdAt: sleepSessions.createdAt,
    }).from(sleepSessions).innerJoin(mediaAssets, and(
      eq(sleepSessions.mediaAssetId, mediaAssets.id),
      eq(mediaAssets.householdId, householdId),
      eq(mediaAssets.status, "ready"),
      eq(mediaAssets.private, true),
      isNull(mediaAssets.deletedAt),
    )).where(and(
      eq(sleepSessions.householdId, householdId),
      eq(sleepSessions.status, "ready"),
      eq(sleepSessions.deletionStatus, "active"),
      ...(childProfileId ? [eq(mediaAssets.childProfileId, childProfileId)] : []),
      ...(voiceId ? [eq(sleepSessions.voiceId, voiceId)] : []),
      ...(favorite !== null ? [eq(sleepSessions.favorite, favorite === "true")] : []),
      ...(cursor ? [or(
        lt(sleepSessions.createdAt, new Date(cursor.createdAt)),
        and(eq(sleepSessions.createdAt, new Date(cursor.createdAt)), lt(sleepSessions.id, cursor.id)),
      )!] : []),
    )).orderBy(desc(sleepSessions.createdAt), desc(sleepSessions.id)).limit(limit).all();
    const last = sessions.length === limit ? sessions.at(-1) : null;
    return jsonNoStore({ apiVersion: "v1", sessions: sessions.map(({ sessionId, ...session }) => ({ id: sessionId, ...session })), nextCursor: last ? encodeLibraryCursor({ createdAt: last.createdAt.getTime(), id: last.sessionId }) : null });
  } catch (error) {
    return apiV1Failure(error, "The private library could not be loaded.");
  }
}
