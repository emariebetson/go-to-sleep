import { env } from "cloudflare:workers";
import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { getDb } from "@/db";
import {
  childProfiles, entitlements, jobs, nearStoryActivationState, storyExperiences, storySoundAssets,
  storyModerationReceipts, voiceConsents, voices,
} from "@/db/schema";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { fetchProviderWithRetries } from "@/lib/provider-guard";
import { loadEffectiveHouseholdEntitlement } from "@/lib/household-entitlements";
import { featureFlagsFromEnv, nearStoryParentBetaFlagsEnabled } from "@/lib/nearyou-foundation";
import type { NearStoryEnqueueInput, NearStoryPostDependencies } from "@/lib/nearstory-route";
import { nearStoryInternalId, storySpeechCostCeilingMicrocents } from "@/lib/nearstory";
import {
  finalizeProviderSpend, markProviderSpendChargeCommitted, providerSpendEstimateMicrocents,
  recordProviderFailure, recordProviderSuccess, reserveProviderSpend,
} from "@/lib/usage-reservations";

const STORY_WORKER_HEARTBEAT_MAX_AGE_MS = 5 * 60_000;
const STORY_MODERATION_RESPONSE_MAX_BYTES = 256_000;

async function boundedModerationJson(response: Response) {
  if (response.headers.get("content-type")?.split(";")[0] !== "application/json" || !response.body) throw new Error("story_moderation_response_invalid");
  const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > STORY_MODERATION_RESPONSE_MAX_BYTES) throw new Error("story_moderation_response_too_large");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > STORY_MODERATION_RESPONSE_MAX_BYTES) { await reader.cancel(); throw new Error("story_moderation_response_too_large"); } chunks.push(value); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as { results?: Array<{ flagged?: boolean }> };
}

function boundedModerationRequestId(value: string | null, fallback: string) {
  return value && value.length <= 200 && !/\p{Cc}/u.test(value) ? value : fallback;
}

export async function storyReady() {
  if (!nearStoryParentBetaFlagsEnabled(featureFlagsFromEnv(process.env))) return false;
  if (!process.env.OPENAI_API_KEY || !process.env.ELEVENLABS_API_KEY || !/^https:\/\//.test(process.env.NEARYOU_MEDIA_WORKER_URL || "") || !/^[A-Za-z0-9_-]{43,128}$/.test(process.env.NEARYOU_MEDIA_WORKER_SECRET || "")) return false;
  const state = await getDb().select().from(nearStoryActivationState).where(eq(nearStoryActivationState.id, "parent-beta")).get();
  return Boolean(
    state?.status === "ready"
    && state.migrationVersion === "0013"
    && state.workerHeartbeatAt
    && state.workerHeartbeatAt.getTime() >= Date.now() - STORY_WORKER_HEARTBEAT_MAX_AGE_MS,
  );
}

export async function moderateWithBudget(text: string, context: { householdId: string; userId: string; requestId: string; requestHash: string }) {
  const moderationId = await nearStoryInternalId("moderation", context.householdId, context.requestId);
  const existing = await getDb().select().from(storyModerationReceipts).where(and(
    eq(storyModerationReceipts.id, moderationId),
    eq(storyModerationReceipts.householdId, context.householdId),
  )).get();
  if (existing) {
    if (existing.requestHash !== context.requestHash) throw new Error("idempotency_conflict");
    return existing.verdict;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "unavailable" as const;
  const model = "omni-moderation-latest";
  const providerIdempotencyKey = await nearStoryInternalId("provider-moderation", context.householdId, context.requestId);
  const spend = await reserveProviderSpend({
    householdId: context.householdId,
    userId: context.userId,
    provider: "openai",
    operation: "story_moderation",
    idempotencyKey: providerIdempotencyKey,
    estimatedMicrocents: providerSpendEstimateMicrocents("openai", "script", Math.max(1, Math.ceil(text.length / 4))),
  });
  if (spend.reservation.status !== "in_flight") return "unavailable" as const;
  await markProviderSpendChargeCommitted(spend.reservation.id);
  let response: Response;
  try {
    response = await fetchProviderWithRetries("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "Idempotency-Key": providerIdempotencyKey },
      body: JSON.stringify({ model, input: text }),
    }, 20_000, providerIdempotencyKey);
  } catch (error) {
    await finalizeProviderSpend(spend.reservation.id, "settled").catch(() => undefined);
    await recordProviderFailure("openai").catch(() => undefined);
    throw error;
  }
  await finalizeProviderSpend(spend.reservation.id, "settled").catch(() => undefined);
  if (!response.ok) {
    await recordProviderFailure("openai").catch(() => undefined);
    return "unavailable" as const;
  }
  const payload = await boundedModerationJson(response);
  const result = payload.results?.[0];
  if (typeof result?.flagged !== "boolean") return "unavailable" as const;
  const verdict = result.flagged ? "unsafe" as const : "safe" as const;
  const providerRequestId = boundedModerationRequestId(response.headers.get("x-request-id") || response.headers.get("request-id"), `unreported:${moderationId}`);
  await getDb().insert(storyModerationReceipts).values({
    id: moderationId,
    householdId: context.householdId,
    requestedByUserId: context.userId,
    requestHash: context.requestHash,
    verdict,
    model,
    providerRequestId,
    createdAt: new Date(),
  }).onConflictDoNothing();
  await recordProviderSuccess("openai").catch(() => undefined);
  return verdict;
}

async function enqueueStory(input: NearStoryEnqueueInput) {
  const db = getDb();
  const existing = await db.select({ id: storyExperiences.id, status: storyExperiences.status, requestHash: storyExperiences.requestHash, jobId: storyExperiences.jobId })
    .from(storyExperiences).where(and(eq(storyExperiences.householdId, input.householdId), eq(storyExperiences.idempotencyKey, input.story.idempotencyKey))).get();
  if (existing) {
    if (existing.requestHash !== input.story.requestHash || !existing.jobId) return { kind: "conflict" as const };
    const job = await db.select({ id: jobs.id, status: jobs.status }).from(jobs).where(and(eq(jobs.id, existing.jobId), eq(jobs.householdId, input.householdId))).get();
    if (!job) return { kind: "conflict" as const };
    return { kind: "duplicate" as const, story: { id: existing.id, status: existing.status }, job };
  }
  const now = Date.now();
  const entitlement = await db.select({ id: entitlements.id }).from(entitlements).where(and(
    eq(entitlements.householdId, input.householdId),
    inArray(entitlements.planId, ["nearyou_plus", "nearyou_family", "nearlegacy"]),
    inArray(entitlements.status, ["active", "grace"]),
    lte(entitlements.validFrom, new Date(now)),
    gt(entitlements.remainingMilliunits, input.story.allowanceMilliunits - 1),
    or(isNull(entitlements.validUntil), gt(entitlements.validUntil, new Date(now))),
  )).orderBy(desc(entitlements.updatedAt)).get();
  if (!entitlement) throw new Error("allowance_exhausted");
  const internalSuffix = input.story.id.slice("story:".length);
  const leaseId = `story-lease:${internalSuffix}`;
  const usageId = `story-usage:${internalSuffix}`;
  const writerSpendId = `story-writer-spend:${internalSuffix}`;
  const speechSpendId = `story-speech-spend:${internalSuffix}`;
  const outputModerationSpendId = `story-output-moderation-spend:${internalSuffix}`;
  const sfxSpendId = `story-sfx-spend:${internalSuffix}`;
  const expiresAt = now + 30 * 60_000;
  const rights = input.story.rightsReceipt;
  const effectCacheKey = typeof input.job.manifest.effectCacheKey === "string" ? input.job.manifest.effectCacheKey : "";
  const cachedEffect = input.request.soundscape === "none" ? true : Boolean(await db.select({ id: storySoundAssets.id }).from(storySoundAssets).where(and(eq(storySoundAssets.cacheKey, effectCacheKey), eq(storySoundAssets.status, "ready"))).get());
  const providerSpendIds = [writerSpendId, outputModerationSpendId, speechSpendId, ...(!cachedEffect ? [sfxSpendId] : [])];
  const statements = [
    env.DB.prepare("INSERT INTO voice_consent_leases (id,household_id,voice_id,consent_id,consent_version,status,expires_at,created_at) VALUES (?,?,?,?,?,'active',?,?)")
      .bind(leaseId, input.householdId, input.request.voiceId, input.story.consentId, input.story.consentVersion, expiresAt, now),
    env.DB.prepare("INSERT INTO usage_reservations (id,household_id,user_id,entitlement_id,operation,quantity,weight_milliunits,idempotency_key,request_hash,status,consent_lease_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'reserved',?,?,?)")
      .bind(usageId, input.householdId, input.userId, entitlement.id, "story_audio_generation", input.request.durationMinutes, input.story.allowanceMilliunits, `story-usage:${input.story.idempotencyKey}`, input.story.requestHash, leaseId, now, now),
    env.DB.prepare("INSERT INTO jobs (id,household_id,requested_by_user_id,type,status,idempotency_key,request_hash,input,reservation_id,consent_id,consent_version,created_at,updated_at) VALUES (?,?,?,'story_audio','queued',?,?,?,?,?,?,?,?)")
      .bind(input.job.id, input.householdId, input.userId, input.story.idempotencyKey, input.job.requestHash, JSON.stringify({ storyId: input.story.id, manifest: input.job.manifest }), usageId, input.story.consentId, input.story.consentVersion, now, now),
    env.DB.prepare("INSERT INTO story_experiences (id,household_id,requested_by_user_id,child_profile_id,voice_id,consent_id,consent_version,consent_lease_id,mode,duration_minutes,plan,rights_actor_user_id,rights_version,rights_canonical_url,rights_attested_at,status,job_id,reservation_id,provider_budget_hold_ids,idempotency_key,request_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?)")
      .bind(input.story.id, input.householdId, input.userId, input.request.childProfileId, input.request.voiceId, input.story.consentId, input.story.consentVersion, leaseId, input.request.mode, input.request.durationMinutes, JSON.stringify(input.story.plan), rights?.actorUserId || null, rights?.version || null, rights?.canonicalUrl || null, rights ? Date.parse(rights.attestedAt) : null, input.job.id, usageId, JSON.stringify(providerSpendIds), input.story.idempotencyKey, input.story.requestHash, now, now),
    env.DB.prepare("INSERT INTO story_provider_budget_holds (id,household_id,user_id,story_id,branch_key,provider,operation,max_microcents,idempotency_key,status,created_at,updated_at) VALUES (?,?,?,?,'root','openai','story_writing',?,?,'reserved',?,?)")
      .bind(writerSpendId, input.householdId, input.userId, input.story.id, input.request.durationMinutes * 10_000, `story-writer:${input.story.idempotencyKey}`, now, now),
    env.DB.prepare("INSERT INTO story_provider_budget_holds (id,household_id,user_id,story_id,branch_key,provider,operation,max_microcents,idempotency_key,status,created_at,updated_at) VALUES (?,?,?,?,'root','openai','story_output_moderation',?,?,'reserved',?,?)")
      .bind(outputModerationSpendId, input.householdId, input.userId, input.story.id, Math.min(100_000, input.request.durationMinutes * 6_000), `story-output-moderation:${input.story.idempotencyKey}`, now, now),
    env.DB.prepare("INSERT INTO story_provider_budget_holds (id,household_id,user_id,story_id,branch_key,provider,operation,max_microcents,idempotency_key,status,created_at,updated_at) VALUES (?,?,?,?,'root','elevenlabs','story_speech',?,?,'reserved',?,?)")
      .bind(speechSpendId, input.householdId, input.userId, input.story.id, storySpeechCostCeilingMicrocents(input.request.durationMinutes), `story-speech:${input.story.idempotencyKey}`, now, now),
    ...(!cachedEffect ? [env.DB.prepare("INSERT INTO story_provider_budget_holds (id,household_id,user_id,story_id,branch_key,provider,operation,max_microcents,idempotency_key,status,created_at,updated_at) VALUES (?,?,?,?,'root','elevenlabs','story_sfx',25000,?,'reserved',?,?)")
      .bind(sfxSpendId, input.householdId, input.userId, input.story.id, `story-sfx:${input.story.idempotencyKey}`, now, now)] : []),
    ...((input.story.plan.beats as Array<{ ordinal: number; purpose: string }>).map((beat) => env.DB.prepare("INSERT INTO story_segments (id,household_id,story_id,branch_key,ordinal,purpose,status,plan_version,prompt_version,created_at,updated_at) VALUES (?,?,?,'root',?,?,'queued','nearstory-plan-v1','nearstory-segment-v1',?,?)")
      .bind(`${input.story.id}:root:${beat.ordinal}`, input.householdId, input.story.id, beat.ordinal, beat.purpose, now, now))),
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const raced = await db.select({ id: storyExperiences.id, status: storyExperiences.status, requestHash: storyExperiences.requestHash, jobId: storyExperiences.jobId })
      .from(storyExperiences).where(and(eq(storyExperiences.householdId, input.householdId), eq(storyExperiences.idempotencyKey, input.story.idempotencyKey))).get();
    if (!raced || raced.requestHash !== input.story.requestHash || !raced.jobId) throw error;
    const job = await db.select({ id: jobs.id, status: jobs.status }).from(jobs).where(and(eq(jobs.id, raced.jobId), eq(jobs.householdId, input.householdId))).get();
    if (!job) throw error;
    return { kind: "duplicate" as const, story: { id: raced.id, status: raced.status }, job };
  }
  return { kind: "created" as const, story: { id: input.story.id, status: "queued" }, job: { id: input.job.id, status: "queued" } };
}

export const nearStoryProductionDependencies: NearStoryPostDependencies = {
  enabled: storyReady,
  authenticate: async (request) => {
    const { householdId, user } = await requireHouseholdContext(request, "job:write");
    return { householdId, userId: user.userId };
  },
  entitlement: loadEffectiveHouseholdEntitlement,
  selectors: async (householdId, input) => {
    const child = await getDb().select({ nickname: childProfiles.nickname, pronunciation: childProfiles.pronunciation, ageMonths: childProfiles.ageMonths })
      .from(childProfiles).where(and(eq(childProfiles.id, input.childProfileId), eq(childProfiles.householdId, householdId), isNull(childProfiles.archivedAt))).get();
    const narrator = await getDb().select({ id: voiceConsents.id, version: voiceConsents.consentVersion }).from(voices)
      .innerJoin(voiceConsents, eq(voices.currentConsentId, voiceConsents.id)).where(and(
        eq(voices.id, input.voiceId), eq(voices.householdId, householdId), eq(voices.status, "ready"),
        eq(voiceConsents.householdId, householdId), eq(voiceConsents.status, "active_verified"), eq(voiceConsents.consentVersion, "voice-v2-live-phrase"),
      )).get();
    return child && narrator ? { child, consent: narrator } : null;
  },
  moderate: moderateWithBudget,
  enqueue: enqueueStory,
};
