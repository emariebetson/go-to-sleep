import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { childProfiles, voiceConsents, voices } from "@/db/schema";
import { loadEffectiveHouseholdEntitlement } from "@/lib/household-entitlements";
import { VERIFIED_VOICE_CONSENT_VERSION } from "@/lib/adult-voice-verification";
import { nearSleepNarratorPolicy } from "@/lib/nearyou-foundation";

export const selectableChildFields = {
  id: childProfiles.id,
  nickname: childProfiles.nickname,
  pronunciation: childProfiles.pronunciation,
  ageMonths: childProfiles.ageMonths,
  bedtimeChallenge: childProfiles.bedtimeChallenge,
  legacyChildId: childProfiles.legacyChildId,
  createdAt: childProfiles.createdAt,
  updatedAt: childProfiles.updatedAt,
};

export async function loadSelectableChildProfiles(householdId: string) {
  const entitlement = await loadEffectiveHouseholdEntitlement(householdId);
  return getDb().select(selectableChildFields).from(childProfiles).where(and(
    eq(childProfiles.householdId, householdId),
    isNull(childProfiles.archivedAt),
  )).orderBy(desc(childProfiles.updatedAt), asc(childProfiles.id)).limit(entitlement.limits.children).all();
}

export async function loadSelectableChildProfile(householdId: string, childProfileId: string) {
  return (await loadSelectableChildProfiles(householdId)).find((profile) => profile.id === childProfileId) || null;
}

export async function loadSelectableVoiceIds(householdId: string) {
  const entitlement = await loadEffectiveHouseholdEntitlement(householdId);
  if (!nearSleepNarratorPolicy(entitlement.planId).privateVoiceCloneAllowed) return [];
  const records = await getDb().select({ id: voices.id }).from(voices)
    .innerJoin(voiceConsents, eq(voices.currentConsentId, voiceConsents.id))
    .where(and(
      eq(voices.householdId, householdId),
      eq(voices.status, "ready"),
      eq(voiceConsents.householdId, householdId),
      eq(voiceConsents.status, "active_verified"),
      eq(voiceConsents.consentVersion, VERIFIED_VOICE_CONSENT_VERSION),
    )).orderBy(asc(voices.createdAt), asc(voices.id)).limit(entitlement.limits.voices).all();
  return records.map((record) => record.id);
}

export async function loadVoiceCloneEligibility(householdId: string, voiceId?: string) {
  const entitlement = await loadEffectiveHouseholdEntitlement(householdId);
  if (!nearSleepNarratorPolicy(entitlement.planId).privateVoiceCloneAllowed) {
    return { allowed: false as const, planId: entitlement.planId, reason: "free_standard_narrator" as const };
  }
  if (!voiceId) return { allowed: true as const, planId: entitlement.planId };
  const slots = await getDb().select({ id: voices.id }).from(voices).where(and(
    eq(voices.householdId, householdId),
    sql`${voices.status} IN ('processing', 'ready')`,
  )).orderBy(asc(voices.createdAt), asc(voices.id)).limit(entitlement.limits.voices).all();
  return slots.some((slot) => slot.id === voiceId)
    ? { allowed: true as const, planId: entitlement.planId }
    : { allowed: false as const, planId: entitlement.planId, reason: "plan_voice_limit" as const };
}
