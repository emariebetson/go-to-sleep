import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  adultOnboardingAcceptances,
  generationOperations,
  voiceConsentLeases,
  voiceConsents,
  voices,
} from "@/db/schema";
import { ADULT_ONBOARDING_VERSION, VERIFIED_VOICE_CONSENT_VERSION } from "./adult-voice-verification";
import type { DurableGenerationError } from "./nearsleep-live-route";

type JsonRecord = Record<string, unknown>;
type GenerationActor = { householdId: string; userId: string };

export type RecoverableResultMetadata = GenerationActor & { operationId: string };
export type GenerationResultBucket = {
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string>; customMetadata?: Record<string, string> } | null>;
  delete(key: string): Promise<void>;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export async function canonicalGenerationFingerprint(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function generationResultStorageKey(householdId: string, operation: string, requestId: string) {
  return `generation-results/${encodeURIComponent(householdId)}/${encodeURIComponent(operation)}/${encodeURIComponent(requestId)}.json`;
}

function containsUnsafeResultKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUnsafeResultKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as JsonRecord).some(([key, child]) => /(?:api.?key|secret|provider(?:Voice|Request|Reference)?Id)/i.test(key) || containsUnsafeResultKey(child));
}

export function validateStoredGenerationResult(
  serialized: string,
  storedMetadata: Record<string, string> | undefined,
  expectedMetadata: RecoverableResultMetadata,
): JsonRecord {
  if (!storedMetadata || storedMetadata.householdId !== expectedMetadata.householdId || storedMetadata.userId !== expectedMetadata.userId || storedMetadata.operationId !== expectedMetadata.operationId) {
    throw new Error("generation_result_tenant_mismatch");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { throw new Error("invalid_generation_result"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_generation_result");
  if (containsUnsafeResultKey(parsed)) throw new Error("unsafe_generation_result");
  return parsed as JsonRecord;
}

export async function persistRecoverableGenerationResult(
  bucket: GenerationResultBucket,
  key: string,
  result: JsonRecord,
  metadata: RecoverableResultMetadata,
) {
  if (containsUnsafeResultKey(result)) throw new Error("unsafe_generation_result");
  await bucket.put(key, JSON.stringify(result), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { householdId: metadata.householdId, userId: metadata.userId, operationId: metadata.operationId },
  });
}

export async function recoverGenerationResult(
  bucket: GenerationResultBucket,
  key: string,
  metadata: RecoverableResultMetadata,
) {
  const object = await bucket.get(key);
  if (!object) return null;
  return validateStoredGenerationResult(await object.text(), object.customMetadata, metadata);
}

export async function requireCurrentAdultOnboarding(actor: GenerationActor) {
  const { getDb } = await import("@/db");
  const accepted = await getDb().select({ id: adultOnboardingAcceptances.id }).from(adultOnboardingAcceptances).where(and(
    eq(adultOnboardingAcceptances.householdId, actor.householdId),
    eq(adultOnboardingAcceptances.adultUserId, actor.userId),
    eq(adultOnboardingAcceptances.version, ADULT_ONBOARDING_VERSION),
  )).get();
  if (!accepted) throw new Response(JSON.stringify({ error: "Complete adult caregiver onboarding before using NearSleep generation." }), {
    status: 403,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function claimGenerationOperation(input: GenerationActor & {
  operationId: string;
  operation: string;
  requestFingerprint: string;
}) {
  const { getDb } = await import("@/db");
  const db = getDb();
  const existing = await db.select().from(generationOperations).where(eq(generationOperations.id, input.operationId)).get();
  if (existing) return classifyGenerationOperation(existing, input);
  const now = new Date();
  try {
    await db.insert(generationOperations).values({
      id: input.operationId,
      householdId: input.householdId,
      userId: input.userId,
      operation: input.operation,
      requestHash: input.requestFingerprint,
      status: "processing",
      createdAt: now,
      updatedAt: now,
    });
    return { kind: "claimed" } as const;
  } catch (error) {
    const raced = await db.select().from(generationOperations).where(eq(generationOperations.id, input.operationId)).get();
    if (!raced) throw error;
    return classifyGenerationOperation(raced, input);
  }
}

function classifyGenerationOperation(
  operation: typeof generationOperations.$inferSelect,
  input: GenerationActor & { operation: string; requestFingerprint: string },
) {
  if (operation.householdId !== input.householdId || operation.userId !== input.userId || operation.operation !== input.operation || operation.requestHash !== input.requestFingerprint) {
    return { kind: "conflict" } as const;
  }
  const result = operation.result && typeof operation.result === "object" && !Array.isArray(operation.result) ? operation.result as JsonRecord : null;
  if ((operation.status === "succeeded" || operation.status === "processing") && result) return { kind: "replay", result } as const;
  if (operation.status === "failed") return {
    kind: "failed",
    error: { status: 503, error: "The previous generation attempt did not complete.", code: operation.errorCode || "generation_failed" } satisfies DurableGenerationError,
  } as const;
  return { kind: "processing" } as const;
}

export async function stageGenerationResult(input: GenerationActor & { operationId: string; result: JsonRecord }) {
  const { getDb } = await import("@/db");
  const updated = await getDb().update(generationOperations).set({ result: input.result, updatedAt: new Date() }).where(and(
    eq(generationOperations.id, input.operationId),
    eq(generationOperations.householdId, input.householdId),
    eq(generationOperations.userId, input.userId),
    eq(generationOperations.status, "processing"),
  )).returning({ id: generationOperations.id }).get();
  if (!updated) throw new Error("generation_result_stage_conflict");
}

export async function completeGenerationOperation(input: GenerationActor & { operationId: string; result: JsonRecord }) {
  const { getDb } = await import("@/db");
  const now = new Date();
  const updated = await getDb().update(generationOperations).set({ status: "succeeded", result: input.result, updatedAt: now, completedAt: now }).where(and(
    eq(generationOperations.id, input.operationId),
    eq(generationOperations.householdId, input.householdId),
    eq(generationOperations.userId, input.userId),
    eq(generationOperations.status, "processing"),
    isNotNull(generationOperations.result),
  )).returning({ id: generationOperations.id }).get();
  if (!updated) throw new Error("generation_success_conflict");
}

export async function failGenerationOperation(input: GenerationActor & { operationId: string; error: DurableGenerationError }) {
  const { getDb } = await import("@/db");
  const now = new Date();
  await getDb().update(generationOperations).set({
    status: "failed",
    errorCode: input.error.code || "generation_failed",
    updatedAt: now,
    completedAt: now,
  }).where(and(
    eq(generationOperations.id, input.operationId),
    eq(generationOperations.householdId, input.householdId),
    eq(generationOperations.userId, input.userId),
    eq(generationOperations.status, "processing"),
    isNull(generationOperations.result),
  ));
}

export async function acquireVoiceConsentLease(input: GenerationActor & { operationId: string; voiceId: string; sessionId?: string | null }) {
  const { getDb } = await import("@/db");
  const { loadSelectableVoiceIds } = await import("@/lib/nearsleep-selectors");
  const db = getDb();
  const leaseId = `voice-lease:${input.operationId}`;
  if (!(await loadSelectableVoiceIds(input.householdId)).includes(input.voiceId)) {
    throw new Response(JSON.stringify({ error: "That verified voice is unavailable under the household’s current plan." }), { status: 403, headers: { "content-type": "application/json" } });
  }
  const existing = await loadCurrentVoiceLease(leaseId, input);
  if (existing) return existing;
  const voice = await db.select({
    voiceId: voices.id,
    consentId: voiceConsents.id,
    consentVersion: voiceConsents.consentVersion,
    providerVoiceId: voices.providerVoiceId,
  }).from(voices).innerJoin(voiceConsents, eq(voices.currentConsentId, voiceConsents.id)).where(and(
    eq(voices.id, input.voiceId),
    eq(voices.householdId, input.householdId),
    eq(voices.status, "ready"),
    eq(voiceConsents.householdId, input.householdId),
    eq(voiceConsents.status, "active_verified"),
    eq(voiceConsents.consentVersion, VERIFIED_VOICE_CONSENT_VERSION),
  )).get();
  if (!voice) throw new Response(JSON.stringify({ error: "That voice requires current verified adult consent before narration." }), { status: 403, headers: { "content-type": "application/json" } });
  const now = new Date();
  try {
    const inserted = await db.insert(voiceConsentLeases).values({
      id: leaseId,
      householdId: input.householdId,
      voiceId: voice.voiceId,
      consentId: voice.consentId,
      consentVersion: voice.consentVersion,
      sessionId: input.sessionId || null,
      status: "active",
      expiresAt: new Date(now.getTime() + 3 * 60_000),
      createdAt: now,
    }).returning().get();
    return { ...inserted, providerVoiceId: voice.providerVoiceId };
  } catch (error) {
    const raced = await loadCurrentVoiceLease(leaseId, input);
    if (!raced) throw error;
    return raced;
  }
}

async function loadCurrentVoiceLease(leaseId: string, input: GenerationActor & { voiceId: string; sessionId?: string | null }) {
  const { getDb } = await import("@/db");
  return getDb().select({
    id: voiceConsentLeases.id,
    householdId: voiceConsentLeases.householdId,
    voiceId: voiceConsentLeases.voiceId,
    consentId: voiceConsentLeases.consentId,
    consentVersion: voiceConsentLeases.consentVersion,
    sessionId: voiceConsentLeases.sessionId,
    status: voiceConsentLeases.status,
    expiresAt: voiceConsentLeases.expiresAt,
    createdAt: voiceConsentLeases.createdAt,
    finalizedAt: voiceConsentLeases.finalizedAt,
    providerVoiceId: voices.providerVoiceId,
  }).from(voiceConsentLeases)
    .innerJoin(voices, eq(voiceConsentLeases.voiceId, voices.id))
    .innerJoin(voiceConsents, eq(voiceConsentLeases.consentId, voiceConsents.id))
    .where(and(
      eq(voiceConsentLeases.id, leaseId),
      eq(voiceConsentLeases.householdId, input.householdId),
      eq(voiceConsentLeases.voiceId, input.voiceId),
      input.sessionId ? eq(voiceConsentLeases.sessionId, input.sessionId) : isNull(voiceConsentLeases.sessionId),
      eq(voiceConsentLeases.status, "active"),
      gt(voiceConsentLeases.expiresAt, new Date()),
      eq(voices.householdId, input.householdId),
      eq(voices.status, "ready"),
      eq(voices.currentConsentId, voiceConsentLeases.consentId),
      eq(voiceConsents.householdId, input.householdId),
      eq(voiceConsents.voiceId, input.voiceId),
      eq(voiceConsents.status, "active_verified"),
      eq(voiceConsents.consentVersion, VERIFIED_VOICE_CONSENT_VERSION),
      eq(voiceConsents.consentVersion, voiceConsentLeases.consentVersion),
    )).get();
}

export async function validateVoiceConsentLease(actor: GenerationActor, leaseId: string) {
  const { getDb } = await import("@/db");
  return getDb().select({ id: voiceConsentLeases.id }).from(voiceConsentLeases)
    .innerJoin(voices, eq(voiceConsentLeases.voiceId, voices.id))
    .innerJoin(voiceConsents, eq(voiceConsentLeases.consentId, voiceConsents.id))
    .where(and(
      eq(voiceConsentLeases.id, leaseId),
      eq(voiceConsentLeases.householdId, actor.householdId),
      eq(voiceConsentLeases.status, "active"),
      gt(voiceConsentLeases.expiresAt, new Date()),
      eq(voices.householdId, actor.householdId),
      eq(voices.status, "ready"),
      eq(voices.currentConsentId, voiceConsentLeases.consentId),
      eq(voiceConsents.status, "active_verified"),
      eq(voiceConsents.consentVersion, VERIFIED_VOICE_CONSENT_VERSION),
      eq(voiceConsents.consentVersion, voiceConsentLeases.consentVersion),
    )).get();
}

export async function validateConsumedVoiceConsentLease(actor: GenerationActor, leaseId: string, sessionId?: string | null) {
  const { getDb } = await import("@/db");
  return getDb().select({ id: voiceConsentLeases.id }).from(voiceConsentLeases)
    .innerJoin(voices, eq(voiceConsentLeases.voiceId, voices.id))
    .innerJoin(voiceConsents, eq(voiceConsentLeases.consentId, voiceConsents.id))
    .where(and(
      eq(voiceConsentLeases.id, leaseId),
      eq(voiceConsentLeases.householdId, actor.householdId),
      eq(voiceConsentLeases.status, "consumed"),
      isNotNull(voiceConsentLeases.finalizedAt),
      sql`${voiceConsentLeases.expiresAt} > ${voiceConsentLeases.finalizedAt}`,
      sessionId ? eq(voiceConsentLeases.sessionId, sessionId) : isNull(voiceConsentLeases.sessionId),
      eq(voices.householdId, actor.householdId),
      eq(voices.status, "ready"),
      eq(voices.currentConsentId, voiceConsentLeases.consentId),
      eq(voiceConsents.householdId, actor.householdId),
      eq(voiceConsents.voiceId, voiceConsentLeases.voiceId),
      eq(voiceConsents.status, "active_verified"),
      eq(voiceConsents.consentVersion, VERIFIED_VOICE_CONSENT_VERSION),
      eq(voiceConsents.consentVersion, voiceConsentLeases.consentVersion),
    )).get();
}

export async function finalizeVoiceConsentLease(actor: GenerationActor, leaseId: string, status: "consumed" | "revoked" | "expired") {
  const { getDb } = await import("@/db");
  const now = new Date();
  const updated = await getDb().update(voiceConsentLeases).set({
    status,
    finalizedAt: status === "revoked" ? sql`COALESCE(${voiceConsentLeases.finalizedAt}, ${now})` : now,
  }).where(and(
    eq(voiceConsentLeases.id, leaseId),
    eq(voiceConsentLeases.householdId, actor.householdId),
    ...(status === "revoked"
      ? [inArray(voiceConsentLeases.status, ["active", "consumed"])]
      : [eq(voiceConsentLeases.status, "active")]),
    ...(status === "consumed" ? [
      gt(voiceConsentLeases.expiresAt, now),
      sql`EXISTS (
        SELECT 1 FROM voices
        JOIN voice_consents ON voice_consents.id = voices.current_consent_id
        WHERE voices.id = ${voiceConsentLeases.voiceId}
          AND voices.household_id = ${voiceConsentLeases.householdId}
          AND voices.status = 'ready'
          AND voice_consents.id = ${voiceConsentLeases.consentId}
          AND voice_consents.household_id = ${voiceConsentLeases.householdId}
          AND voice_consents.voice_id = ${voiceConsentLeases.voiceId}
          AND voice_consents.consent_version = ${voiceConsentLeases.consentVersion}
          AND voice_consents.consent_version = ${VERIFIED_VOICE_CONSENT_VERSION}
          AND voice_consents.status = 'active_verified'
      )`,
    ] : []),
  )).returning({ id: voiceConsentLeases.id }).get();
  if (!updated && status === "consumed") throw new Error("voice_consent_lease_invalidated");
}
