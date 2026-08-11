import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { storyExperiences } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { jsonNoStore } from "@/lib/http";
import { createNearStoryPostHandler } from "@/lib/nearstory-route";
import { nearStoryProductionDependencies } from "./production";

export const POST = createNearStoryPostHandler(nearStoryProductionDependencies);

export async function GET(request: Request) {
  try {
    if (!await nearStoryProductionDependencies.enabled()) return jsonNoStore({ error: "NearStory is not available." }, { status: 404 });
    const { householdId } = await requireHouseholdContext(request, "job:read");
    const stories = await getDb().select({
      id: storyExperiences.id, childProfileId: storyExperiences.childProfileId, voiceId: storyExperiences.voiceId,
      mode: storyExperiences.mode, durationMinutes: storyExperiences.durationMinutes, status: storyExperiences.status,
      jobId: storyExperiences.jobId, mediaAssetId: storyExperiences.mediaAssetId, errorCode: storyExperiences.errorCode,
      createdAt: storyExperiences.createdAt, updatedAt: storyExperiences.updatedAt,
    }).from(storyExperiences).where(and(eq(storyExperiences.householdId, householdId), ne(storyExperiences.status, "deleted")))
      .orderBy(desc(storyExperiences.createdAt)).limit(100).all();
    return jsonNoStore({ apiVersion: "v1", stories, microphoneEnabled: false });
  } catch (error) {
    return apiV1Failure(error, "Stories could not be loaded.");
  }
}
