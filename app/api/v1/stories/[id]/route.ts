import { env } from "cloudflare:workers";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { storyExperiences, storySegments } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { storyReady } from "../production";
import { canonicalRequestHash } from "@/lib/nearsleep-library";
import { nearStoryInternalId } from "@/lib/nearstory";
import { fenceStoryForDeletion, reconcilePendingStoryDeletions } from "@/lib/nearstory-deletion";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!await storyReady()) return jsonNoStore({ error: "NearStory is not available." }, { status: 404 });
    const { householdId } = await requireHouseholdContext(request, "job:read");
    const { id } = await context.params;
    const story = await getDb().select({
      id: storyExperiences.id, childProfileId: storyExperiences.childProfileId, voiceId: storyExperiences.voiceId,
      mode: storyExperiences.mode, durationMinutes: storyExperiences.durationMinutes, plan: storyExperiences.plan,
      status: storyExperiences.status, highestPlayedSegment: storyExperiences.highestPlayedSegment,
      jobId: storyExperiences.jobId, mediaAssetId: storyExperiences.mediaAssetId, errorCode: storyExperiences.errorCode,
      createdAt: storyExperiences.createdAt, updatedAt: storyExperiences.updatedAt,
    }).from(storyExperiences).where(and(eq(storyExperiences.id, id), eq(storyExperiences.householdId, householdId), ne(storyExperiences.status, "deleted"), ne(storyExperiences.status, "delete_pending"))).get();
    if (!story) return jsonNoStore({ error: "Story not found." }, { status: 404 });
    const segments = await getDb().select({ ordinal: storySegments.ordinal, narration: storySegments.narration, status: storySegments.status, startMs: storySegments.startMs, endMs: storySegments.endMs }).from(storySegments).where(and(eq(storySegments.storyId, id), eq(storySegments.householdId, householdId), eq(storySegments.branchKey, "root"))).orderBy(storySegments.ordinal).all();
    return jsonNoStore({ apiVersion: "v1", story: { ...story, segments }, microphoneEnabled: false });
  } catch (error) { return apiV1Failure(error, "Story could not be loaded."); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!await storyReady()) return jsonNoStore({ error: "NearStory is not available." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
    if (!idempotencyKey || idempotencyKey.length > 200) return jsonNoStore({ error: "A bounded Idempotency-Key header is required." }, { status: 400 });
    const { householdId } = await requireHouseholdContext(request, "job:write");
    const { id } = await context.params;
    const body = await readJsonObject(request, 1_000);
    if (Object.keys(body).some((key) => key !== "playedThroughSegment") || !Number.isInteger(body.playedThroughSegment)) return jsonNoStore({ error: "playedThroughSegment must be an integer." }, { status: 400 });
    const target = Number(body.playedThroughSegment);
    const story = await getDb().select({ highest: storyExperiences.highestPlayedSegment }).from(storyExperiences)
      .where(and(eq(storyExperiences.id, id), eq(storyExperiences.householdId, householdId), eq(storyExperiences.status, "completed"))).get();
    if (!story) return jsonNoStore({ error: "Story not found." }, { status: 404 });
    if (target === story.highest) return jsonNoStore({ story: { id, highestPlayedSegment: target }, duplicate: true });
    if (target !== story.highest + 1) return jsonNoStore({ error: "Playback progress must advance one delivered segment at a time." }, { status: 409 });
    const ready = await getDb().select({ id: storySegments.id }).from(storySegments).where(and(eq(storySegments.householdId, householdId), eq(storySegments.storyId, id), eq(storySegments.branchKey, "root"), eq(storySegments.ordinal, target), eq(storySegments.status, "ready"))).get();
    if (!ready) return jsonNoStore({ error: "That segment has not been delivered." }, { status: 409 });
    const updated = await getDb().update(storyExperiences).set({ highestPlayedSegment: target, updatedAt: new Date() }).where(and(eq(storyExperiences.id, id), eq(storyExperiences.householdId, householdId), eq(storyExperiences.highestPlayedSegment, story.highest), eq(storyExperiences.status, "completed"))).returning({ id: storyExperiences.id }).get();
    if (!updated) return jsonNoStore({ error: "Playback progress changed; retry with the latest state." }, { status: 409 });
    return jsonNoStore({ story: { id, highestPlayedSegment: target } });
  } catch (error) { return apiV1Failure(error, "Story playback progress could not be saved."); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!await storyReady()) return jsonNoStore({ error: "NearStory is not available." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
    if (!idempotencyKey || idempotencyKey.length > 200) return jsonNoStore({ error: "A bounded Idempotency-Key header is required." }, { status: 400 });
    const { householdId } = await requireHouseholdContext(request, "job:write");
    const { id } = await context.params;
    const requestHash = await canonicalRequestHash({ operation: "story_delete", storyId: id });
    const operationId = await nearStoryInternalId("story-delete", householdId, idempotencyKey);
    const operation = await fenceStoryForDeletion({ householdId, storyId: id, operationId, idempotencyKey, requestHash });
    if (!operation) return jsonNoStore({ deleted: true });
    await reconcilePendingStoryDeletions({ bucket: env.AUDIO, limit: 1 });
    const current = await getDb().select({ status: storyExperiences.status }).from(storyExperiences).where(and(eq(storyExperiences.id, id), eq(storyExperiences.householdId, householdId))).get();
    return jsonNoStore({ deleted: current?.status === "deleted", status: current?.status === "deleted" ? "deleted" : "delete_pending", retryable: current?.status !== "deleted" }, { status: current?.status === "deleted" ? 200 : 202 });
  } catch (error) { return apiV1Failure(error, "Story could not be deleted."); }
}
