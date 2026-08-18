import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { deletionReconciliations, voiceConsents, voices } from "@/db/schema";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { demoNarratorEnabled } from "@/lib/demo-narrator";
import { assertTrustedMutationOrigin, fetchWithTimeout, jsonNoStore, readJsonObject } from "@/lib/http";
import { requireCurrentAdultOnboarding } from "@/lib/nearsleep-live";
import { nearSleepNarratorPolicy } from "@/lib/nearyou-foundation";
import { loadEffectiveHouseholdEntitlement } from "@/lib/household-entitlements";
import { loadSelectableVoiceIds, loadVoiceCloneEligibility } from "@/lib/nearsleep-selectors";
import { narrationSavePolicy } from "@/lib/usage-reservations";

const ELEVENLABS = "https://api.elevenlabs.io/v1";

function voiceClaimInput(body: Record<string, unknown>) {
  const requestId = String(body.requestId || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
    throw new Error("A stable voice request ID is required.");
  }
  if (body.adultSelfAttestation !== true) throw new Error("Confirm that this is your own adult voice.");
  const name = String(body.name || "Parent voice").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Parent voice";
  return { requestId, name };
}

async function deleteProviderVoice(apiKey: string, providerVoiceId: string) {
  const response = await fetchWithTimeout(`${ELEVENLABS}/voices/${encodeURIComponent(providerVoiceId)}`, { method: "DELETE", headers: { "xi-api-key": apiKey } }, 30_000);
  return response.ok || response.status === 404;
}

export async function getProductionVoices(request: Request) {
  try {
    const { householdId, user } = await requireHouseholdContext(request, "voice:read");
    const records = await getDb().select({
      id: voices.id,
      name: voices.name,
      status: voices.status,
      ownerUserId: voices.userId,
      consentStatus: voiceConsents.status,
      consentVersion: voiceConsents.consentVersion,
    }).from(voices).leftJoin(voiceConsents, eq(voices.currentConsentId, voiceConsents.id)).where(and(
      eq(voices.householdId, householdId),
      ne(voices.status, "deleted"),
    )).orderBy(desc(voices.createdAt)).all();
    const entitlement = await loadEffectiveHouseholdEntitlement(householdId);
    const policy = nearSleepNarratorPolicy(entitlement.planId, demoNarratorEnabled());
    const allowedNarrationDurations = narrationSavePolicy(
      { planId: entitlement.planId, remainingMilliunits: Number.MAX_SAFE_INTEGER },
      entitlement.planId === "nearsleep_free" ? 5 : 10,
    ).allowedDurations;
    const selectableVoiceIds = new Set(await loadSelectableVoiceIds(householdId));
    const publicRecords = records
      .filter((voice) => selectableVoiceIds.has(voice.id) || (voice.ownerUserId === user.userId && voice.status === "processing"))
      .map(({ ownerUserId, ...voice }) => ({ ...voice, ownedByCurrentUser: ownerUserId === user.userId }));
    return jsonNoStore({
      voices: publicRecords,
      voice: publicRecords.find((voice) => voice.status === "ready" && voice.consentStatus === "active_verified") || null,
      demoEnabled: policy.standardNarratorAvailable,
      standardNarratorAvailable: policy.standardNarratorAvailable,
      voiceCloneAllowed: policy.privateVoiceCloneAllowed,
      allowedNarrationDurations,
      lockedNarrationDurations: entitlement.planId === "nearsleep_free" ? [20] : [],
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: "Voice profiles could not be loaded." }, { status: 500 });
  }
}

export async function postProductionVoice(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    const { householdId, user } = await requireHouseholdContext(request, "voice:consent");
    await requireCurrentAdultOnboarding({ householdId, userId: user.userId });
    const eligibility = await loadVoiceCloneEligibility(householdId);
    if (!eligibility.allowed) return jsonNoStore({
      error: "NearSleep Free uses the standard non-cloned narrator. Private household voices are available on paid plans.",
      code: eligibility.reason,
      standardNarratorAvailable: true,
    }, { status: 402 });
    let input;
    try { input = voiceClaimInput(await readJsonObject(request, 4_000)); } catch (error) {
      if (error instanceof Response) return error;
      return jsonNoStore({ error: error instanceof Error ? error.message : "Voice request is invalid." }, { status: 400 });
    }
    const db = getDb();
    const voiceId = crypto.randomUUID();
    const consentId = `voice-consent:${voiceId}:initial`;
    const now = new Date();
    try {
      await db.batch([
        db.insert(voices).values({
          id: voiceId,
          userId: user.userId,
          householdId,
          currentConsentId: null,
          creationRequestId: input.requestId,
          // The placeholder is never returned or sent to a provider. The random
          // live-phrase ceremony creates the first real provider clone.
          providerVoiceId: `pending:${householdId}:${input.requestId}`,
          name: input.name,
          status: "processing",
          consentAttestedAt: now,
          createdAt: now,
        }),
        db.insert(voiceConsents).values({
          id: consentId,
          householdId,
          voiceId,
          adultUserId: user.userId,
          consentVersion: "adult-self-claim-v1",
          scope: "adult_self_private_narration",
          status: "pending_verification",
          evidence: { kind: "authenticated_adult_self_attestation", verified: false, posthumousSynthesis: false },
          attestedAt: now,
        }),
        db.update(voices).set({ currentConsentId: consentId }).where(and(
          eq(voices.id, voiceId), eq(voices.householdId, householdId), eq(voices.userId, user.userId), eq(voices.status, "processing"),
        )),
      ]);
      return jsonNoStore({ voiceId, status: "pending_verification" }, { status: 201 });
    } catch (error) {
      const existing = await db.select({ id: voices.id, householdId: voices.householdId, userId: voices.userId, name: voices.name, status: voices.status })
        .from(voices).where(and(eq(voices.householdId, householdId), eq(voices.creationRequestId, input.requestId))).get();
      if (existing?.householdId === householdId && existing.userId === user.userId && existing.name === input.name) {
        return jsonNoStore({ voiceId: existing.id, status: existing.status === "ready" ? "verified" : "pending_verification", duplicate: true });
      }
      const detail = error instanceof Error ? error.message : "";
      if (detail.includes("free_voice_clone_unavailable")) return jsonNoStore({ error: "NearSleep Free uses the standard non-cloned narrator. Private household voices are available on paid plans.", code: "free_standard_narrator", standardNarratorAvailable: true }, { status: 402 });
      if (detail.includes("voice_limit") || detail.includes("UNIQUE")) return jsonNoStore({ error: "This household has reached its adult voice limit." }, { status: 409 });
      if (detail.includes("voice_entitlement")) return jsonNoStore({ error: "A current NearSleep household entitlement is required." }, { status: 402 });
      throw error;
    }
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Production voice slot claim failed", error);
    return jsonNoStore({ error: "Voice setup could not reserve a household slot." }, { status: 500 });
  }
}

export async function deleteProductionVoice(request: Request) {
  try {
    assertTrustedMutationOrigin(request);
    const { householdId, user } = await requireHouseholdContext(request, "voice:consent");
    const search = new URL(request.url).searchParams;
    const requestedId = search.get("voiceId")?.trim();
    const deleteAll = search.get("all") === "true";
    if (!requestedId && !deleteAll) return jsonNoStore({ error: "A local voice ID is required." }, { status: 400 });
    const records = await getDb().select().from(voices).where(and(
      eq(voices.householdId, householdId), eq(voices.userId, user.userId), ne(voices.status, "deleted"),
      ...(deleteAll ? [] : [eq(voices.id, requestedId!)]),
    )).all();
    if (!records.length) return jsonNoStore({ error: "Voice not found." }, { status: 404 });
    const apiKey = process.env.ELEVENLABS_API_KEY;
    for (const record of records) {
      const now = new Date();
      const db = getDb();
      await db.batch([
        db.update(voices).set({ status: "deleted", deletedAt: now }).where(and(eq(voices.id, record.id), eq(voices.householdId, householdId), eq(voices.userId, user.userId))),
        db.update(voiceConsents).set({ status: "revoked", revokedAt: now }).where(and(eq(voiceConsents.householdId, householdId), eq(voiceConsents.voiceId, record.id))),
        db.insert(deletionReconciliations).values({
          id: `voice-delete:${record.id}`,
          scope: "voice",
          scopeId: record.id,
          status: "cleanup_pending",
          storageKeys: [],
          providerReferences: record.providerVoiceId.startsWith("pending:") ? [] : [record.providerVoiceId],
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing(),
      ]);
      let cleanupVerified = record.providerVoiceId.startsWith("pending:");
      if (!cleanupVerified && apiKey) cleanupVerified = await deleteProviderVoice(apiKey, record.providerVoiceId).catch(() => false);
      if (cleanupVerified) {
        await db.update(deletionReconciliations).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(deletionReconciliations.id, `voice-delete:${record.id}`), eq(deletionReconciliations.status, "cleanup_pending")));
      }
      if (!cleanupVerified) return jsonNoStore({ deleted: true, cleanupPending: true }, { status: 202 });
    }
    return jsonNoStore({ deleted: true, count: records.length });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: "Voice deletion failed." }, { status: 500 });
  }
}
