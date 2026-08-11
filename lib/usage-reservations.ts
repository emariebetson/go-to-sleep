import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  entitlements,
  providerCircuits,
  providerSpendReservations,
  usageReservations,
} from "@/db/schema";
import type { ProviderName } from "@/lib/provider-guard";
import { PLAN_CATALOG, type PlanId } from "@/lib/nearyou-foundation";

export type GenerationScriptMode = "curated" | "personalized";
export type GenerationMode = "preview" | "save";

export function allowanceWeightForScript(mode: GenerationScriptMode) {
  void mode;
  return 0;
}

export function allowanceWeightForNarration(planId: string, generationMode: GenerationMode, durationMinutes: number) {
  if (![5, 10, 15, 20].includes(durationMinutes)) throw new Error("Narration duration is invalid.");
  if (generationMode === "preview") return 0;
  if (planId === "nearsleep_free") {
    if (durationMinutes !== 5) throw new Error("NearSleep Free is limited to one five-minute saved creation.");
    return 1_000;
  }
  if (planId === "nearsleep_plus_legacy") return 1_000;
  if (!["nearyou_plus", "nearyou_family", "nearlegacy"].includes(planId)) throw new Error("Narration plan is invalid.");
  return durationMinutes * 1_000;
}

export function narrationSavePolicy(entitlement: { planId: string; remainingMilliunits: number }, durationMinutes: number) {
  const allowedDurations = entitlement.planId === "nearsleep_free" ? [5] : [5, 10, 15, 20];
  let requiredMilliunits;
  try {
    requiredMilliunits = allowanceWeightForNarration(entitlement.planId, "save", durationMinutes);
  } catch (error) {
    if (entitlement.planId === "nearsleep_free") throw new Error("allowance_exhausted: NearSleep Free is limited to one five-minute saved creation.");
    throw error;
  }
  if (!Number.isInteger(entitlement.remainingMilliunits) || entitlement.remainingMilliunits < requiredMilliunits) {
    throw new Error("allowance_exhausted");
  }
  return { allowedDurations, requiredMilliunits };
}

export function nearSleepEntitlementIsCurrent(input: { planId: string; status: string; validFrom: Date | number; validUntil: Date | number | null }, now = new Date()) {
  const plan = PLAN_CATALOG[input.planId as PlanId];
  const nowMs = now.getTime();
  return Boolean(
    plan?.features.nearsleep
    && (input.status === "active" || input.status === "grace")
    && new Date(input.validFrom).getTime() <= nowMs
    && (input.validUntil === null || new Date(input.validUntil).getTime() > nowMs),
  );
}

export async function requireCurrentNearSleepEntitlement(householdId: string) {
  const { getDb } = await import("@/db");
  const now = new Date();
  const entitlement = await getDb().select({
    id: entitlements.id,
    planId: entitlements.planId,
    status: entitlements.status,
    validFrom: entitlements.validFrom,
    validUntil: entitlements.validUntil,
    remainingMilliunits: entitlements.remainingMilliunits,
  }).from(entitlements).where(and(
    eq(entitlements.householdId, householdId),
    inArray(entitlements.status, ["active", "grace"]),
    lte(entitlements.validFrom, now),
    or(isNull(entitlements.validUntil), gt(entitlements.validUntil, now)),
  )).orderBy(
    sql`CASE WHEN ${entitlements.planId} = 'nearsleep_free' THEN 0 ELSE 1 END DESC`,
    sql`CASE WHEN ${entitlements.status} = 'active' THEN 1 ELSE 0 END DESC`,
    desc(entitlements.updatedAt),
  ).get();
  if (!entitlement || !nearSleepEntitlementIsCurrent(entitlement, now)) throw new Error("allowance_exhausted");
  return entitlement;
}

export function providerSpendEstimateMicrocents(provider: ProviderName, operation: "script" | "audio" | "transcription" | "voice_clone", units: number) {
  if (!Number.isInteger(units) || units < 0 || units > 100_000) throw new Error("Provider estimate units are invalid.");
  if (provider === "openai") return Math.max(1, units * (operation === "transcription" ? 200 : 50));
  return Math.max(1, units * (operation === "voice_clone" ? 4_000 : 3_000));
}

export function classifyReservationFailure(error: unknown) {
  const detail = error instanceof Error ? error.message : "";
  if (detail.includes("allowance_exhausted")) return { status: 402, code: "allowance_exhausted" } as const;
  if (detail.includes("provider_concurrency_limit") || detail.includes("household_spend_limit") || detail.includes("global_spend_limit")) {
    return { status: 429, code: "provider_busy" } as const;
  }
  if (detail.includes("provider_circuit_open")) return { status: 503, code: "provider_unavailable" } as const;
  if (detail.includes("idempotency_conflict")) return { status: 409, code: "idempotency_conflict" } as const;
  return { status: 503, code: "reservation_unavailable" } as const;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function reserveHouseholdAllowance(input: {
  householdId: string;
  userId: string;
  idempotencyKey: string;
  operation: string;
  quantity: number;
  weightMilliunits: number;
  requestFingerprint: string;
  consentLeaseId?: string | null;
}) {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0 || !Number.isInteger(input.weightMilliunits) || input.weightMilliunits < 0) {
    throw new Error("invalid_usage_reservation");
  }
  if (input.weightMilliunits === 0) return { reservation: null, duplicate: false };
  const { getDb } = await import("@/db");
  const db = getDb();
  const requestHash = await sha256(input.requestFingerprint);
  const existing = await db.select().from(usageReservations).where(and(
    eq(usageReservations.householdId, input.householdId),
    eq(usageReservations.idempotencyKey, input.idempotencyKey),
  )).get();
  if (existing) {
    if (existing.userId !== input.userId || existing.operation !== input.operation || existing.quantity !== input.quantity || existing.weightMilliunits !== input.weightMilliunits || existing.requestHash !== requestHash) {
      throw new Error("idempotency_conflict");
    }
    return { reservation: existing, duplicate: true };
  }
  const now = new Date();
  const entitlement = await requireCurrentNearSleepEntitlement(input.householdId);
  const id = crypto.randomUUID();
  try {
    const inserted = await db.insert(usageReservations).values({
      id,
      householdId: input.householdId,
      userId: input.userId,
      entitlementId: entitlement.id,
      operation: input.operation,
      quantity: input.quantity,
      weightMilliunits: input.weightMilliunits,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      status: "reserved",
      consentLeaseId: input.consentLeaseId || null,
      createdAt: now,
      updatedAt: now,
    }).returning().get();
    return { reservation: inserted, duplicate: false };
  } catch (error) {
    const raced = await db.select().from(usageReservations).where(and(
      eq(usageReservations.householdId, input.householdId),
      eq(usageReservations.idempotencyKey, input.idempotencyKey),
    )).get();
    if (!raced) throw error;
    if (raced.userId !== input.userId || raced.operation !== input.operation || raced.quantity !== input.quantity || raced.weightMilliunits !== input.weightMilliunits || raced.requestHash !== requestHash) {
      throw new Error("idempotency_conflict");
    }
    return { reservation: raced, duplicate: true };
  }
}

export async function finalizeHouseholdAllowance(reservationId: string | null | undefined, status: "committed" | "released") {
  if (!reservationId) return;
  const { getDb } = await import("@/db");
  await getDb().update(usageReservations).set({ status, updatedAt: new Date(), finalizedAt: new Date() }).where(and(
    eq(usageReservations.id, reservationId),
    eq(usageReservations.status, "reserved"),
  ));
}

export async function reserveProviderSpend(input: {
  householdId: string;
  userId: string;
  provider: ProviderName;
  operation: string;
  idempotencyKey: string;
  estimatedMicrocents: number;
}) {
  if (!Number.isInteger(input.estimatedMicrocents) || input.estimatedMicrocents <= 0) throw new Error("invalid_provider_spend_reservation");
  const { getDb } = await import("@/db");
  const db = getDb();
  const existing = await db.select().from(providerSpendReservations).where(and(
    eq(providerSpendReservations.householdId, input.householdId),
    eq(providerSpendReservations.idempotencyKey, input.idempotencyKey),
  )).get();
  if (existing) {
    if (existing.userId !== input.userId || existing.provider !== input.provider || existing.operation !== input.operation || existing.estimatedMicrocents !== input.estimatedMicrocents) throw new Error("idempotency_conflict");
    return { reservation: existing, duplicate: true };
  }
  const now = new Date();
  try {
    const inserted = await db.insert(providerSpendReservations).values({
      id: crypto.randomUUID(),
      householdId: input.householdId,
      userId: input.userId,
      provider: input.provider,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      estimatedMicrocents: input.estimatedMicrocents,
      status: "in_flight",
      expiresAt: new Date(now.getTime() + 2 * 60_000),
      createdAt: now,
      updatedAt: now,
    }).returning().get();
    return { reservation: inserted, duplicate: false };
  } catch (error) {
    const raced = await db.select().from(providerSpendReservations).where(and(
      eq(providerSpendReservations.householdId, input.householdId),
      eq(providerSpendReservations.idempotencyKey, input.idempotencyKey),
    )).get();
    if (!raced) throw error;
    if (raced.userId !== input.userId || raced.provider !== input.provider || raced.operation !== input.operation || raced.estimatedMicrocents !== input.estimatedMicrocents) throw new Error("idempotency_conflict");
    return { reservation: raced, duplicate: true };
  }
}

export async function finalizeProviderSpend(reservationId: string | null | undefined, status: "settled" | "released", actualMicrocents?: number) {
  if (!reservationId) return null;
  if (actualMicrocents !== undefined && (!Number.isInteger(actualMicrocents) || actualMicrocents < 0)) throw new Error("invalid_provider_spend_actual");
  if (status === "released" && actualMicrocents !== undefined) throw new Error("invalid_provider_spend_actual");
  const { getDb } = await import("@/db");
  const expectedStatus = status === "settled" ? "charge_committed" : "in_flight";
  const finalized = await getDb().update(providerSpendReservations).set({
    status,
    actualMicrocents: status === "settled" ? actualMicrocents ?? null : null,
    updatedAt: new Date(),
  }).where(and(eq(providerSpendReservations.id, reservationId), eq(providerSpendReservations.status, expectedStatus))).returning({
    id: providerSpendReservations.id,
    status: providerSpendReservations.status,
  }).get();
  if (!finalized) throw new Error("provider_spend_finalize_conflict");
  return finalized;
}

export async function markProviderSpendChargeCommitted(reservationId: string) {
  const { getDb } = await import("@/db");
  const now = new Date();
  const committed = await getDb().update(providerSpendReservations).set({
    status: "charge_committed",
    chargeCommittedAt: now,
    updatedAt: now,
  }).where(and(
    eq(providerSpendReservations.id, reservationId),
    eq(providerSpendReservations.status, "in_flight"),
    gt(providerSpendReservations.expiresAt, now),
  )).returning({ id: providerSpendReservations.id }).get();
  if (!committed) throw new Error("provider_spend_commit_conflict");
  return committed;
}

export async function executeConservativelyAccountedProviderCall<T>(input: {
  commitBeforeInvoke: () => Promise<unknown>;
  invoke: () => Promise<T>;
  settleAfterInvoke: () => Promise<unknown>;
  recordSuccess: () => Promise<unknown>;
  recordFailure: () => Promise<unknown>;
}) {
  await input.commitBeforeInvoke();
  try {
    const result = await input.invoke();
    await input.settleAfterInvoke().catch((error) => console.error("Provider spend settlement telemetry failed", error));
    await input.recordSuccess().catch((error) => console.error("Provider success telemetry failed", error));
    return result;
  } catch (error) {
    await input.settleAfterInvoke().catch((settlementError) => console.error("Provider spend settlement telemetry failed", settlementError));
    await input.recordFailure().catch((telemetryError) => console.error("Provider failure telemetry failed", telemetryError));
    throw error;
  }
}

export async function releaseExpiredProviderSpend(now = new Date()) {
  const { getDb } = await import("@/db");
  const db = getDb();
  const released = await db.update(providerSpendReservations).set({ status: "released", updatedAt: now }).where(and(
    eq(providerSpendReservations.status, "in_flight"),
    lte(providerSpendReservations.expiresAt, now),
  )).returning({ id: providerSpendReservations.id }).all();
  const settled = await db.update(providerSpendReservations).set({ status: "settled", actualMicrocents: null, updatedAt: now }).where(and(
    eq(providerSpendReservations.status, "charge_committed"),
    lte(providerSpendReservations.expiresAt, now),
  )).returning({ id: providerSpendReservations.id }).all();
  return { released, settled };
}

export async function recordProviderSuccess(provider: ProviderName) {
  const { getDb } = await import("@/db");
  const now = new Date();
  await getDb().insert(providerCircuits).values({ provider, consecutiveFailures: 0, openUntil: null, updatedAt: now }).onConflictDoUpdate({
    target: providerCircuits.provider,
    set: { consecutiveFailures: 0, openUntil: null, updatedAt: now },
  });
}

export async function recordProviderFailure(provider: ProviderName) {
  const { getDb } = await import("@/db");
  const now = new Date();
  await getDb().insert(providerCircuits).values({ provider, consecutiveFailures: 1, openUntil: null, updatedAt: now }).onConflictDoUpdate({
    target: providerCircuits.provider,
    set: {
      consecutiveFailures: sql`${providerCircuits.consecutiveFailures} + 1`,
      openUntil: sql`CASE WHEN ${providerCircuits.consecutiveFailures} + 1 >= 5 THEN ${new Date(now.getTime() + 60_000)} ELSE NULL END`,
      updatedAt: now,
    },
  });
}
