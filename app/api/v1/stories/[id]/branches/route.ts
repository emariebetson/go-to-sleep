import { env } from "cloudflare:workers";
import { and, count, desc, eq, gt, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { getDb } from "@/db";
import { entitlements, storyBranchRequests, storyExperiences, storyModerationReceipts, storySegments, voiceConsents, voices } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { moderateParentBranchInput, nearStoryInternalId, storySpeechCostCeilingMicrocents } from "@/lib/nearstory";
import { canonicalJobRequestHash } from "@/lib/nearyou-foundation";
import { moderateWithBudget, storyReady } from "../../production";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (process.env.NEARYOU_ENABLE_STORY_BRANCHING !== "true") return jsonNoStore({ error: "Not found." }, { status: 404 });
    if (!await storyReady()) return jsonNoStore({ error: "NearStory is not available." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return jsonNoStore({ error: "Content-Type must be application/json." }, { status: 415 });
    const { householdId, user } = await requireHouseholdContext(request, "job:write");
    const { id: storyId } = await context.params;
    const body = await readJsonObject(request, 4_000);
    const headerKey = request.headers.get("idempotency-key")?.trim() || "";
    if (!headerKey || headerKey.length > 200) return jsonNoStore({ error: "A bounded Idempotency-Key header is required." }, { status: 400 });
    if (body.requestId !== headerKey) return jsonNoStore({ error: "Idempotency-Key must match requestId." }, { status: 409 });
    const story = await getDb().select({
      id: storyExperiences.id, status: storyExperiences.status, highestPlayedSegment: storyExperiences.highestPlayedSegment,
      durationMinutes: storyExperiences.durationMinutes, reservationId: storyExperiences.reservationId,
      voiceId: storyExperiences.voiceId,
      consentId: storyExperiences.consentId, consentVersion: storyExperiences.consentVersion,
      consentLeaseId: storyExperiences.consentLeaseId,
    }).from(storyExperiences).where(and(eq(storyExperiences.id, storyId), eq(storyExperiences.householdId, householdId), ne(storyExperiences.status, "deleted"), ne(storyExperiences.status, "delete_pending"))).get();
    if (!story) return jsonNoStore({ error: "Story not found." }, { status: 404 });
    const segmentCount = (await getDb().select({ value: count() }).from(storySegments).where(and(eq(storySegments.storyId, story.id), eq(storySegments.householdId, householdId), eq(storySegments.branchKey, "root"))).get())?.value || 0;
    const requestHash = await canonicalJobRequestHash("story_audio", { storyId, direction: body.direction, afterSegment: body.afterSegment });
    const branchId = await nearStoryInternalId("branch", householdId, `${storyId}:${headerKey}`);
    const existing = await getDb().select().from(storyBranchRequests).where(and(eq(storyBranchRequests.id, branchId), eq(storyBranchRequests.householdId, householdId), eq(storyBranchRequests.storyId, storyId))).get();
    if (existing) {
      if (existing.requestHash !== requestHash) return jsonNoStore({ error: "That request ID is already associated with another branch." }, { status: 409 });
      return jsonNoStore({ apiVersion: "v1", branch: { id: existing.id, status: existing.status, afterSegment: existing.afterSegment }, duplicate: true, microphoneEnabled: false });
    }
    const branchCount = (await getDb().select({ value: count() }).from(storyBranchRequests).where(and(eq(storyBranchRequests.storyId, story.id), ne(storyBranchRequests.status, "rejected"), ne(storyBranchRequests.status, "failed"))).get())?.value || 0;
    if (branchCount >= 3) return jsonNoStore({ error: "This story has reached its three-branch limit." }, { status: 409 });
    if (!Number.isInteger(body.afterSegment) || typeof body.direction !== "string" || segmentCount !== 5 || Number(body.afterSegment) <= story.highestPlayedSegment || Number(body.afterSegment) < 0 || Number(body.afterSegment) >= segmentCount) return jsonNoStore({ error: "A valid delivered branch point and direction are required." }, { status: 422 });
    const estimatedRemainingMinutes = Math.max(1, Math.ceil(story.durationMinutes * (segmentCount - Number(body.afterSegment)) / segmentCount));
    const estimatedWeight = estimatedRemainingMinutes * 1_000;
    const entitlement = await getDb().select({ id: entitlements.id }).from(entitlements).where(and(
      eq(entitlements.householdId, householdId), inArray(entitlements.planId, ["nearyou_plus", "nearyou_family", "nearlegacy"]),
      inArray(entitlements.status, ["active", "grace"]), lte(entitlements.validFrom, new Date()),
      or(isNull(entitlements.validUntil), gt(entitlements.validUntil, new Date())), gt(entitlements.remainingMilliunits, estimatedWeight - 1),
    )).orderBy(desc(entitlements.updatedAt)).get();
    if (!entitlement) return jsonNoStore({ error: "NearStory allowance is unavailable for this branch." }, { status: 402 });
    let input;
    try {
      input = await moderateParentBranchInput(body, { highestPlayedSegment: story.highestPlayedSegment, segmentCount }, (text) => moderateWithBudget(text, { householdId, userId: user.userId, requestId: headerKey, requestHash }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Branch moderation is unavailable.";
      return jsonNoStore({ error: message }, { status: /unavailable/i.test(message) ? 503 : 422 });
    }
    const jobId = await nearStoryInternalId("branch-job", householdId, `${storyId}:${headerKey}`);
    const now = Date.now();
    const holdPrefix = branchId.slice("branch:".length);
    const remainingMinutes = Math.max(1, Math.ceil(story.durationMinutes * (segmentCount - input.afterSegment) / segmentCount));
    const weightMilliunits = remainingMinutes * 1_000;
    if (weightMilliunits !== estimatedWeight) return jsonNoStore({ error: "Branch allowance changed; retry." }, { status: 409 });
    const consent = await getDb().select({ id: voiceConsents.id, version: voiceConsents.consentVersion }).from(voices).innerJoin(voiceConsents, eq(voices.currentConsentId, voiceConsents.id)).where(and(
      eq(voices.id, story.voiceId), eq(voices.householdId, householdId), eq(voices.status, "ready"),
      eq(voiceConsents.householdId, householdId), eq(voiceConsents.status, "active_verified"), eq(voiceConsents.consentVersion, "voice-v2-live-phrase"),
    )).get();
    if (!consent) return jsonNoStore({ error: "Narrator consent must be verified again before branching." }, { status: 409 });
    const usageId = `branch-usage:${holdPrefix}`;
    const leaseId = `branch-lease:${holdPrefix}`;
    const moderationId = await nearStoryInternalId("moderation", householdId, headerKey);
    const moderation = await getDb().select({ model: storyModerationReceipts.model, requestId: storyModerationReceipts.providerRequestId, verdict: storyModerationReceipts.verdict })
      .from(storyModerationReceipts).where(and(eq(storyModerationReceipts.id, moderationId), eq(storyModerationReceipts.householdId, householdId), eq(storyModerationReceipts.requestHash, requestHash))).get();
    if (!moderation || moderation.verdict !== "safe") return jsonNoStore({ error: "Branch moderation receipt is unavailable." }, { status: 503 });
    const statements = [
      env.DB.prepare("INSERT INTO voice_consent_leases (id,household_id,voice_id,consent_id,consent_version,status,expires_at,created_at) VALUES (?,?,?,?,?,'active',?,?)")
        .bind(leaseId, householdId, story.voiceId, consent.id, consent.version, now + 30 * 60_000, now),
      env.DB.prepare("INSERT INTO usage_reservations (id,household_id,user_id,entitlement_id,operation,quantity,weight_milliunits,idempotency_key,request_hash,status,consent_lease_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'reserved',?,?,?)")
        .bind(usageId, householdId, user.userId, entitlement.id, "story_audio_generation", remainingMinutes, weightMilliunits, `story-branch-usage:${storyId}:${headerKey}`, requestHash, leaseId, now, now),
      env.DB.prepare("INSERT INTO jobs (id,household_id,requested_by_user_id,type,status,idempotency_key,request_hash,input,reservation_id,consent_id,consent_version,created_at,updated_at) VALUES (?,?,?,'story_audio','queued',?,?,?,?,?,?,?,?)")
        .bind(jobId, householdId, user.userId, `branch:${storyId}:${headerKey}`, requestHash, JSON.stringify({ storyId, branchId, direction: input.direction, afterSegment: input.afterSegment }), usageId, consent.id, consent.version, now, now),
      env.DB.prepare("INSERT INTO story_branch_requests (id,household_id,story_id,requested_by_user_id,direction,after_segment,request_hash,job_id,reservation_id,consent_lease_id,moderation_receipt_id,reserved_minutes,status,moderation_provenance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)")
        .bind(branchId, householdId, storyId, user.userId, input.direction, input.afterSegment, requestHash, jobId, usageId, leaseId, moderationId, remainingMinutes, JSON.stringify({ ...moderation, receiptId: moderationId, policyVersion: "story-parent-branch-v1" }), now, now),
      env.DB.prepare("INSERT INTO story_provider_budget_holds (id,household_id,user_id,story_id,branch_key,provider,operation,max_microcents,idempotency_key,status,created_at,updated_at) VALUES (?,?,?,? ,?,'openai','story_writing',75000,?,'reserved',?,?)")
        .bind(`branch-writer:${holdPrefix}`, householdId, user.userId, storyId, branchId, `branch-writer:${branchId}`, now, now),
      env.DB.prepare("INSERT INTO story_provider_budget_holds (id,household_id,user_id,story_id,branch_key,provider,operation,max_microcents,idempotency_key,status,created_at,updated_at) VALUES (?,?,?,? ,?,'openai','story_output_moderation',50000,?,'reserved',?,?)")
        .bind(`branch-moderation:${holdPrefix}`, householdId, user.userId, storyId, branchId, `branch-moderation:${branchId}`, now, now),
      env.DB.prepare("INSERT INTO story_provider_budget_holds (id,household_id,user_id,story_id,branch_key,provider,operation,max_microcents,idempotency_key,status,created_at,updated_at) VALUES (?,?,?,? ,?,'elevenlabs','story_speech',?,?,'reserved',?,?)")
        .bind(`branch-speech:${holdPrefix}`, householdId, user.userId, storyId, branchId, storySpeechCostCeilingMicrocents(remainingMinutes), `branch-speech:${branchId}`, now, now),
    ];
    try { await env.DB.batch(statements); }
    catch (error) {
      const raced = await getDb().select().from(storyBranchRequests).where(and(eq(storyBranchRequests.id, branchId), eq(storyBranchRequests.householdId, householdId))).get();
      if (!raced || raced.requestHash !== requestHash) throw error;
      return jsonNoStore({ apiVersion: "v1", branch: { id: raced.id, status: raced.status, afterSegment: raced.afterSegment }, duplicate: true, microphoneEnabled: false });
    }
    return jsonNoStore({ apiVersion: "v1", branch: { id: branchId, status: "queued", afterSegment: input.afterSegment }, job: { id: jobId, status: "queued" }, microphoneEnabled: false }, { status: 202 });
  } catch (error) {
    return apiV1Failure(error, "Story branch could not be queued.");
  }
}
