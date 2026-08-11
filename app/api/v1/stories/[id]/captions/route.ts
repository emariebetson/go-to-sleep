import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { storyExperiences, storySegments } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { jsonNoStore } from "@/lib/http";
import { storyReady } from "../../production";

function timestamp(seconds: number) { const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds % 3600 / 60); const remainder = (seconds % 60).toFixed(3).padStart(6, "0"); return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${remainder}`; }

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!await storyReady()) return jsonNoStore({ error: "NearStory is not available." }, { status: 404 });
    const { householdId } = await requireHouseholdContext(request, "job:read"); const { id } = await context.params;
    const story = await getDb().select({ id: storyExperiences.id }).from(storyExperiences).where(and(eq(storyExperiences.id, id), eq(storyExperiences.householdId, householdId), eq(storyExperiences.status, "completed"))).get();
    if (!story) return jsonNoStore({ error: "Story not found." }, { status: 404 });
    const segments = await getDb().select({ ordinal: storySegments.ordinal, narration: storySegments.narration, startMs: storySegments.startMs, endMs: storySegments.endMs }).from(storySegments).where(and(eq(storySegments.storyId, id), eq(storySegments.householdId, householdId), eq(storySegments.branchKey, "root"), eq(storySegments.status, "ready"))).orderBy(storySegments.ordinal).all();
    if (segments.length !== 5 || segments.some((segment) => !segment.narration || segment.startMs === null || segment.endMs === null || segment.endMs <= segment.startMs)) return jsonNoStore({ error: "Story captions are awaiting reconciliation." }, { status: 503 });
    const body = `WEBVTT\n\n${segments.map((segment) => `${segment.ordinal + 1}\n${timestamp(segment.startMs! / 1000)} --> ${timestamp(segment.endMs! / 1000)}\n${segment.narration!.replace(/-->/g, "→")}\n`).join("\n")}`;
    return new Response(body, { headers: { "content-type": "text/vtt; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (error) { return apiV1Failure(error, "Story captions could not be loaded."); }
}
