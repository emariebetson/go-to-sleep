import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { voiceConsents, voices } from "@/db/schema";
import { apiV1Failure, badRequest, requireHouseholdContext } from "@/lib/api-v1-context";
import { parseVoiceConsentInput } from "@/lib/api-v1-input";
import { assertSameOrigin, jsonNoStore, readJsonObject } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const { householdId } = await requireHouseholdContext(request, "voice:read");
    const records = await getDb().select({
      id: voices.id,
      name: voices.name,
      status: voices.status,
      createdAt: voices.createdAt,
      consentVersion: voiceConsents.consentVersion,
      consentStatus: voiceConsents.status,
      consentScope: voiceConsents.scope,
    }).from(voices)
      .leftJoin(voiceConsents, eq(voices.currentConsentId, voiceConsents.id))
      .where(and(eq(voices.householdId, householdId), ne(voices.status, "deleted")))
      .orderBy(desc(voices.createdAt)).all();
    return jsonNoStore({ apiVersion: "v1", voices: records });
  } catch (error) {
    return apiV1Failure(error, "Voice profiles could not be loaded.");
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { householdId, user } = await requireHouseholdContext(request, "voice:consent");
    let input;
    try { input = parseVoiceConsentInput(await readJsonObject(request, 4_000)); } catch (error) { return error instanceof Response ? error : badRequest(error); }
    const ownedVoice = await getDb().select({ id: voices.id }).from(voices)
      .where(and(eq(voices.id, input.voiceId), eq(voices.householdId, householdId), eq(voices.userId, user.userId), ne(voices.status, "deleted"))).get();
    if (!ownedVoice) return jsonNoStore({ error: "Voice profile not found." }, { status: 404 });
    const now = new Date();
    const inserted = await getDb().insert(voiceConsents).values({
      id: input.requestId,
      householdId,
      voiceId: input.voiceId,
      adultUserId: user.userId,
      consentVersion: input.consentVersion,
      scope: input.scope,
      status: "pending_verification",
      evidence: { kind: "authenticated_adult_self_attestation", verified: false, posthumousSynthesis: false },
      attestedAt: now,
    }).onConflictDoNothing().returning({ id: voiceConsents.id }).get();
    const consent = await getDb().select({
      id: voiceConsents.id,
      voiceId: voiceConsents.voiceId,
      consentVersion: voiceConsents.consentVersion,
      scope: voiceConsents.scope,
      status: voiceConsents.status,
      attestedAt: voiceConsents.attestedAt,
    }).from(voiceConsents).where(and(eq(voiceConsents.id, input.requestId), eq(voiceConsents.householdId, householdId))).get();
    if (!consent || consent.voiceId !== input.voiceId || consent.consentVersion !== input.consentVersion) {
      return jsonNoStore({ error: "That request ID is already associated with different consent data." }, { status: 409 });
    }
    await getDb().update(voices).set({ currentConsentId: consent.id }).where(and(eq(voices.id, input.voiceId), eq(voices.householdId, householdId)));
    return jsonNoStore({ apiVersion: "v1", consent, duplicate: !inserted }, { status: inserted ? 201 : 200 });
  } catch (error) {
    return apiV1Failure(error, "Voice consent could not be recorded.");
  }
}
