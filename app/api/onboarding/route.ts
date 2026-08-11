import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { adultOnboardingAcceptances } from "@/db/schema";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import {
  ADULT_ONBOARDING_ATTESTATION,
  ADULT_ONBOARDING_VERSION,
  parseAdultOnboardingAcceptance,
} from "@/lib/adult-voice-verification";
import { assertTrustedMutationOrigin, jsonNoStore, readJsonObject } from "@/lib/http";
import { featureFlagsFromEnv, nearSleepProductionEnabled } from "@/lib/nearyou-foundation";

function upgradeDisabled() {
  return !featureFlagsFromEnv(process.env).productionUpgradeFoundation;
}

export async function GET(request: Request) {
  try {
    const flags = featureFlagsFromEnv(process.env);
    if (!flags.productionUpgradeFoundation) return jsonNoStore({ error: "The production upgrade foundation is not enabled." }, { status: 404 });
    const { householdId, user } = await requireHouseholdContext(request, "voice:consent");
    const acceptance = await getDb().select({
      id: adultOnboardingAcceptances.id,
      version: adultOnboardingAcceptances.version,
      acceptedAt: adultOnboardingAcceptances.acceptedAt,
    }).from(adultOnboardingAcceptances).where(and(
      eq(adultOnboardingAcceptances.householdId, householdId),
      eq(adultOnboardingAcceptances.adultUserId, user.userId),
      eq(adultOnboardingAcceptances.version, ADULT_ONBOARDING_VERSION),
    )).get();
    return jsonNoStore({
      version: ADULT_ONBOARDING_VERSION,
      attestation: ADULT_ONBOARDING_ATTESTATION,
      productionMode: nearSleepProductionEnabled(flags),
      accepted: Boolean(acceptance),
      acceptance: acceptance || null,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: "Adult caregiver onboarding could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (upgradeDisabled()) return jsonNoStore({ error: "The production upgrade foundation is not enabled." }, { status: 404 });
    assertTrustedMutationOrigin(request);
    const { householdId, user } = await requireHouseholdContext(request, "voice:consent");
    let input;
    try { input = parseAdultOnboardingAcceptance(await readJsonObject(request, 4_000)); } catch (error) {
      if (error instanceof Response) return error;
      return jsonNoStore({ error: error instanceof Error ? error.message : "Adult caregiver onboarding is invalid." }, { status: 400 });
    }
    const acceptedAt = new Date();
    const inserted = await getDb().insert(adultOnboardingAcceptances).values({
      id: input.requestId,
      householdId,
      adultUserId: user.userId,
      version: input.version,
      attestation: ADULT_ONBOARDING_ATTESTATION,
      acceptedAt,
    }).onConflictDoNothing().returning({ id: adultOnboardingAcceptances.id }).get();
    const acceptance = await getDb().select({
      id: adultOnboardingAcceptances.id,
      householdId: adultOnboardingAcceptances.householdId,
      adultUserId: adultOnboardingAcceptances.adultUserId,
      version: adultOnboardingAcceptances.version,
      acceptedAt: adultOnboardingAcceptances.acceptedAt,
    }).from(adultOnboardingAcceptances).where(eq(adultOnboardingAcceptances.id, input.requestId)).get();
    if (!acceptance || acceptance.householdId !== householdId || acceptance.adultUserId !== user.userId || acceptance.version !== input.version) {
      return jsonNoStore({ error: "That request ID is already associated with different onboarding data." }, { status: 409 });
    }
    return jsonNoStore({ version: input.version, acceptedAt: acceptance.acceptedAt, duplicate: !inserted }, { status: inserted ? 201 : 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Adult caregiver onboarding failed", error);
    return jsonNoStore({ error: "Adult caregiver onboarding could not be recorded." }, { status: 500 });
  }
}
