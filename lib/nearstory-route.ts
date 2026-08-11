import { canonicalJobRequestHash, PLAN_CATALOG, type PlanId } from "./nearyou-foundation";
import { assertTrustedMutationOrigin } from "./http";
import { buildStoryPlan, buildStoryWorkerManifest, createStoryRightsReceipt, moderateStoryPlan, nearStoryInternalId, parseStoryRequest, storyAllowanceMilliunits, type StoryRequest } from "./nearstory";

type Entitlement = { planId: string; status: string; validFrom: Date | number; validUntil: Date | number | null; remainingMilliunits: number };
type Selectors = { child: { nickname: string; pronunciation: string; ageMonths: number | null }; consent: { id: string; version: string } };
type StoryResult = { id: string; status: string };
type JobResult = { id: string; status: string };

export type NearStoryEnqueueInput = {
  householdId: string;
  userId: string;
  request: StoryRequest;
  story: { id: string; idempotencyKey: string; requestHash: string; plan: Record<string, unknown>; consentId: string; consentVersion: string; allowanceMilliunits: number; rightsReceipt: ReturnType<typeof createStoryRightsReceipt> };
  job: { id: string; requestHash: string; manifest: Record<string, unknown> };
};

export type NearStoryPostDependencies = {
  enabled: () => Promise<boolean>;
  authenticate: (request: Request) => Promise<{ householdId: string; userId: string }>;
  entitlement: (householdId: string) => Promise<Entitlement>;
  selectors: (householdId: string, input: StoryRequest) => Promise<Selectors | null>;
  moderate: (text: string, context: { householdId: string; userId: string; requestId: string; requestHash: string }) => Promise<"safe" | "unsafe" | "unavailable">;
  enqueue: (input: NearStoryEnqueueInput) => Promise<
    | { kind: "created" | "duplicate"; story: StoryResult; job: JobResult }
    | { kind: "conflict" }
  >;
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function hasCurrentStoryEntitlement(entitlement: Entitlement, now = Date.now()) {
  const plan = PLAN_CATALOG[entitlement.planId as PlanId];
  return Boolean(
    plan?.features.nearstoryParentControlled
    && (entitlement.status === "active" || entitlement.status === "grace")
    && new Date(entitlement.validFrom).getTime() <= now
    && (entitlement.validUntil === null || new Date(entitlement.validUntil).getTime() > now),
  );
}

export function createNearStoryPostHandler(dependencies: NearStoryPostDependencies) {
  return async function POST(request: Request) {
    try {
      if (!await dependencies.enabled()) return json({ error: "NearStory is not available." }, 404);
      try { assertTrustedMutationOrigin(request); } catch (error) { if (error instanceof Response) return error; throw error; }
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Content-Type must be application/json." }, 415);
      let raw: unknown;
      try {
        const encoded = await request.text();
        if (new TextEncoder().encode(encoded).byteLength > 12_000) return json({ error: "Story request is too large." }, 413);
        raw = JSON.parse(encoded);
      } catch { return json({ error: "A valid JSON body is required." }, 400); }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json({ error: "A JSON object is required." }, 400);
      let input: StoryRequest;
      try { input = parseStoryRequest(raw as Record<string, unknown>); } catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid story request." }, 400); }
      const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
      if (!idempotencyKey || idempotencyKey.length > 200) return json({ error: "A bounded Idempotency-Key header is required." }, 400);
      if (idempotencyKey !== input.requestId) return json({ error: "Idempotency-Key must match requestId." }, 409);
      const identity = await dependencies.authenticate(request);
      const entitlement = await dependencies.entitlement(identity.householdId);
      if (!Number.isInteger(entitlement.remainingMilliunits) || entitlement.remainingMilliunits < 0) return json({ error: "Household allowance is unavailable." }, 503);
      if (!hasCurrentStoryEntitlement(entitlement)) return json({ error: "NearStory is included with NearYou Plus or higher." }, 402);
      const allowanceMilliunits = storyAllowanceMilliunits(entitlement.planId, input.durationMinutes);
      if (entitlement.remainingMilliunits < allowanceMilliunits) return json({ error: "Monthly narration allowance is exhausted." }, 402);
      const selectors = await dependencies.selectors(identity.householdId, input);
      if (!selectors) return json({ error: "Select an active child profile and verified adult narrator from this household." }, 403);
      const plan = buildStoryPlan(input, selectors.child);
      const requestHash = await canonicalJobRequestHash("story_audio", input as unknown as Record<string, unknown>);
      try { await moderateStoryPlan(plan, (text) => dependencies.moderate(text, { householdId: identity.householdId, userId: identity.userId, requestId: input.requestId, requestHash })); } catch (error) {
        const message = error instanceof Error ? error.message : "Story safety moderation is unavailable.";
        return json({ error: message }, /idempotency_conflict/i.test(message) ? 409 : /unavailable/i.test(message) ? 503 : 422);
      }
      const storyId = await nearStoryInternalId("story", identity.householdId, idempotencyKey);
      const jobId = await nearStoryInternalId("job", identity.householdId, idempotencyKey);
      const manifest = await buildStoryWorkerManifest({ storyId, plan, voiceId: input.voiceId });
      const result = await dependencies.enqueue({
        householdId: identity.householdId,
        userId: identity.userId,
        request: input,
        story: {
          id: storyId,
          idempotencyKey: input.requestId,
          requestHash,
          plan: plan as unknown as Record<string, unknown>,
          consentId: selectors.consent.id,
          consentVersion: selectors.consent.version,
          allowanceMilliunits,
          rightsReceipt: createStoryRightsReceipt(input, identity.userId),
        },
        job: { id: jobId, requestHash, manifest: manifest as unknown as Record<string, unknown> },
      });
      if (result.kind === "conflict") return json({ error: "That request ID is already associated with different story data." }, 409);
      return json({ apiVersion: "v1", story: result.story, job: result.job, duplicate: result.kind === "duplicate", microphoneEnabled: false }, result.kind === "created" ? 202 : 200);
    } catch (error) {
      if (error instanceof Response) return error;
      console.error("NearStory enqueue failed", error);
      return json({ error: "NearStory could not be queued." }, 503);
    }
  };
}
