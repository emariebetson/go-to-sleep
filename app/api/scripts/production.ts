import { env } from "cloudflare:workers";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { assertTrustedMutationOrigin, fetchWithTimeout, jsonNoStore, readJsonObject } from "@/lib/http";
import { moderatedNarrationOrFallback, type RemoteModerationVerdict } from "@/lib/child-safety";
import {
  claimGenerationOperation,
  completeGenerationOperation,
  failGenerationOperation,
  generationResultStorageKey,
  persistRecoverableGenerationResult,
  recoverGenerationResult,
  requireCurrentAdultOnboarding,
  stageGenerationResult,
  type GenerationResultBucket,
} from "@/lib/nearsleep-live";
import { createDurableGenerationPostHandler, GenerationResultReconciliationError } from "@/lib/nearsleep-live-route";
import { featureFlagsFromEnv, nearSleepProductionEnabled } from "@/lib/nearyou-foundation";
import { loadSelectableChildProfile } from "@/lib/nearsleep-selectors";
import { curatedScript, personalizedScriptResult, prepareProductionScriptClaim, type ScriptInput } from "@/lib/sleep-script";
import { validateNarrationSafety } from "@/lib/sleep-session";
import { resolveYouTubeSource } from "@/lib/youtube-source";
import {
  finalizeProviderSpend,
  classifyReservationFailure,
  markProviderSpendChargeCommitted,
  narrationSavePolicy,
  providerSpendEstimateMicrocents,
  recordProviderFailure,
  recordProviderSuccess,
  requireCurrentNearSleepEntitlement,
  reserveHouseholdAllowance,
  reserveProviderSpend,
} from "@/lib/usage-reservations";

type ParsedScriptRequest = { input: ScriptInput; requestId: string; fingerprint: string };
type ScriptResult = {
  script: string;
  mode: ScriptInput["scriptMode"];
  source: ScriptInput["source"];
  notice: string | null;
  rightsReceipt: null | { version: "linked-metadata-rights-v1"; attested: true; sourceUrl: string };
};

function scriptResult(value: Record<string, unknown>): ScriptResult {
  if (typeof value.script !== "string" || !["curated", "personalized"].includes(String(value.mode || ""))) throw new Error("invalid_generation_result");
  const source = value.source;
  if (source !== null && source !== undefined && (typeof source !== "object" || Array.isArray(source))) throw new Error("invalid_generation_result");
  const receipt = value.rightsReceipt;
  const notice = value.notice;
  if (notice !== null && notice !== undefined && (typeof notice !== "string" || notice.length > 300)) throw new Error("invalid_generation_result");
  if (receipt !== null && (typeof receipt !== "object" || Array.isArray(receipt)
    || (receipt as Record<string, unknown>).version !== "linked-metadata-rights-v1"
    || (receipt as Record<string, unknown>).attested !== true
    || typeof (receipt as Record<string, unknown>).sourceUrl !== "string")) throw new Error("invalid_generation_result");
  return {
    script: value.script,
    mode: value.mode as ScriptInput["scriptMode"],
    source: (source || null) as ScriptInput["source"],
    notice: typeof notice === "string" ? notice : null,
    rightsReceipt: receipt as ScriptResult["rightsReceipt"],
  };
}

function resultBucket() {
  return (env as unknown as { AUDIO?: GenerationResultBucket }).AUDIO;
}

async function guardedChildSafetyModeration(input: { householdId: string; userId: string; requestId: string; narration: string }): Promise<RemoteModerationVerdict> {
  const estimate = providerSpendEstimateMicrocents("openai", "script", Math.ceil(input.narration.length / 4));
  let spend;
  try {
    spend = await reserveProviderSpend({
      householdId: input.householdId,
      userId: input.userId,
      provider: "openai",
      operation: "nearsleep_child_safety_moderation",
      idempotencyKey: `script:${input.requestId}:moderation`,
      estimatedMicrocents: estimate,
    });
  } catch {
    return "unavailable";
  }
  if (spend.reservation.status !== "in_flight") return "unavailable";
  let invoked = false;
  try {
    await markProviderSpendChargeCommitted(spend.reservation.id);
    invoked = true;
    const response = await fetchWithTimeout("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "omni-moderation-latest", input: input.narration }),
    }, 30_000);
    await finalizeProviderSpend(spend.reservation.id, "settled", estimate).catch((error) => console.error("Moderation spend settlement failed", error));
    if (!response.ok) {
      await recordProviderFailure("openai").catch(() => undefined);
      return "unavailable";
    }
    const payload = await response.json() as { results?: Array<{ flagged?: boolean }> };
    if (typeof payload.results?.[0]?.flagged !== "boolean") {
      await recordProviderFailure("openai").catch(() => undefined);
      return "unavailable";
    }
    await recordProviderSuccess("openai").catch(() => undefined);
    return payload.results[0].flagged ? "unsafe" : "safe";
  } catch {
    if (invoked) await finalizeProviderSpend(spend.reservation.id, "settled").catch(() => undefined);
    else await finalizeProviderSpend(spend.reservation.id, "released").catch(() => undefined);
    await recordProviderFailure("openai").catch(() => undefined);
    return "unavailable";
  }
}

async function durablyStoreScriptResult(input: {
  bucket: GenerationResultBucket;
  key: string;
  result: ScriptResult;
  householdId: string;
  userId: string;
  operationId: string;
}) {
  const metadata = { householdId: input.householdId, userId: input.userId, operationId: input.operationId };
  const writes = await Promise.allSettled([
    persistRecoverableGenerationResult(input.bucket, input.key, input.result, metadata),
    stageGenerationResult({ ...metadata, result: input.result }),
  ]);
  if (writes.every((write) => write.status === "rejected")) throw new GenerationResultReconciliationError();
}

export const postProductionScript = createDurableGenerationPostHandler<ParsedScriptRequest, ScriptResult>({
  operation: "script",
  enabled: () => nearSleepProductionEnabled(featureFlagsFromEnv(process.env)),
  authenticate: async (request) => {
    assertTrustedMutationOrigin(request);
    const context = await requireHouseholdContext(request, "job:write");
    return { householdId: context.householdId, userId: context.user.userId };
  },
  requireAdultGate: async (actor) => {
    if (!resultBucket()) throw jsonNoStore({ error: "Private generation result storage is unavailable." }, { status: 503 });
    await requireCurrentAdultOnboarding(actor);
  },
  parse: async (request) => {
    try { return await prepareProductionScriptClaim(await readJsonObject(request, 8_000)); } catch (error) {
      if (error instanceof Response) throw error;
      throw jsonNoStore({ error: error instanceof Error ? error.message : "Script request is invalid." }, { status: 400 });
    }
  },
  identify: ({ requestId, fingerprint }) => ({ requestId, requestFingerprint: fingerprint }),
  claim: async ({ operationId, householdId, userId, requestFingerprint }) => {
    const claim = await claimGenerationOperation({ operationId, householdId, userId, requestFingerprint, operation: "script" });
    return claim.kind === "replay" ? { kind: "replay", result: scriptResult(claim.result) } : claim;
  },
  recover: async ({ operationId, householdId, userId, requestId }) => {
    const recovered = await recoverGenerationResult(
      resultBucket()!,
      generationResultStorageKey(householdId, "script", requestId),
      { operationId, householdId, userId },
    );
    return recovered ? scriptResult(recovered) : null;
  },
  execute: async ({ operationId, householdId, userId, requestId, requestFingerprint, input: parsed }) => {
    const input = parsed.input;
    let entitlement;
    try {
      entitlement = await requireCurrentNearSleepEntitlement(householdId);
      narrationSavePolicy(entitlement, Number(input.duration));
    } catch (error) {
      const failure = classifyReservationFailure(error);
      throw jsonNoStore({ error: "A current NearSleep household entitlement with enough allowance for this duration is required.", code: failure.code }, { status: failure.status });
    }
    const childProfile = await loadSelectableChildProfile(householdId, input.childId!);
    if (!childProfile) throw jsonNoStore({ error: "That child profile is unavailable under the household’s current plan." }, { status: 404 });
    if (childProfile.nickname !== input.childName
      || childProfile.ageMonths !== Number(input.ageMonths)
      || childProfile.bedtimeChallenge !== input.challenge) {
      throw jsonNoStore({ error: "That child profile changed. Refresh it before writing a bedtime.", code: "child_profile_changed" }, { status: 409 });
    }
    await reserveHouseholdAllowance({
      householdId,
      userId,
      idempotencyKey: `script:${requestId}:allowance`,
      operation: "nearsleep_script_generation",
      quantity: 1,
      weightMilliunits: 0,
      requestFingerprint,
    });

    input.source = await resolveYouTubeSource(input.sourceUrl);
    const safeFallback = curatedScript(input);
    let script: string;
    let notice: string | null = null;
    let providerOutput = false;
    if (input.scriptMode === "curated") {
      script = curatedScript(input);
    } else if (!process.env.OPENAI_API_KEY) {
      const provider = await personalizedScriptResult(input, false);
      script = provider.script;
      notice = provider.notice;
    } else {
      const estimate = providerSpendEstimateMicrocents("openai", "script", Number(input.duration) * 115);
      const spend = await reserveProviderSpend({
        householdId,
        userId,
        provider: "openai",
        operation: "nearsleep_script_generation",
        idempotencyKey: `script:${requestId}:openai`,
        estimatedMicrocents: estimate,
      });
      if (spend.reservation.status !== "in_flight") throw jsonNoStore({ error: "This script request is already being reconciled.", code: "generation_in_progress" }, { status: 409 });
      let invoked = false;
      try {
        await markProviderSpendChargeCommitted(spend.reservation.id);
        invoked = true;
        const provider = await personalizedScriptResult(input, true);
        await finalizeProviderSpend(spend.reservation.id, "settled", estimate).catch((error) => console.error("Script provider spend settlement failed", error));
        await (provider.providerFailed ? recordProviderFailure("openai") : recordProviderSuccess("openai")).catch((error) => console.error("Script provider circuit telemetry failed", error));
        script = provider.script;
        notice = provider.notice;
        providerOutput = provider.providerUsed;
      } catch (error) {
        if (invoked) {
          await finalizeProviderSpend(spend.reservation.id, "settled").catch((settlementError) => console.error("Script provider spend settlement failed", settlementError));
          await recordProviderFailure("openai").catch((telemetryError) => console.error("Script provider circuit telemetry failed", telemetryError));
        } else {
          await finalizeProviderSpend(spend.reservation.id, "released").catch(() => undefined);
        }
        throw error;
      }
    }
    const moderated = await moderatedNarrationOrFallback(
      script,
      safeFallback,
      providerOutput ? (narration) => guardedChildSafetyModeration({ householdId, userId, requestId, narration }) : async () => "safe",
    );
    script = moderated.script;
    try { validateNarrationSafety(script); } catch { script = safeFallback; }
    const result: ScriptResult = {
      script,
      mode: input.scriptMode,
      source: input.source || null,
      notice,
      rightsReceipt: input.sourceUrl
        ? { version: "linked-metadata-rights-v1", attested: true, sourceUrl: input.sourceUrl }
        : null,
    };
    await durablyStoreScriptResult({
      bucket: resultBucket()!,
      key: generationResultStorageKey(householdId, "script", requestId),
      result,
      householdId,
      userId,
      operationId,
    });
    return result;
  },
  stageResult: ({ operationId, householdId, userId, result }) => stageGenerationResult({ operationId, householdId, userId, result }),
  succeed: ({ operationId, householdId, userId, result }) => completeGenerationOperation({ operationId, householdId, userId, result }),
  fail: ({ operationId, householdId, userId, error }) => failGenerationOperation({ operationId, householdId, userId, error }),
  recordReconciliation: ({ operationId, error }) => console.error("Script generation result requires reconciliation", operationId, error),
});
