import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { users, voiceConsents, voices } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { ensureUser } from "@/lib/data";
import { assertSameOrigin, fetchWithTimeout, jsonNoStore, readLimitedBytes } from "@/lib/http";
import { classifyVoiceCreationError } from "@/lib/elevenlabs";
import { demoNarratorEnabled } from "@/lib/demo-narrator";
import { featureFlagsFromEnv, nearSleepProductionEnabled } from "@/lib/nearyou-foundation";

const ELEVENLABS = "https://api.elevenlabs.io/v1";

export async function GET(request: Request) {
  try {
    if (nearSleepProductionEnabled(featureFlagsFromEnv(process.env))) {
      const { getProductionVoices } = await import("./production");
      return getProductionVoices(request);
    }
    const user = await requireApiUser(request);
    await ensureUser(user);
    const voice = await getDb().select({ providerVoiceId: voices.providerVoiceId, name: voices.name })
      .from(voices)
      .where(and(eq(voices.userId, user.userId), eq(voices.status, "ready")))
      .get();
    return jsonNoStore({ voice: voice ? { voiceId: voice.providerVoiceId, name: voice.name } : null, demoEnabled: demoNarratorEnabled() });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: "Voice profile could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (nearSleepProductionEnabled(featureFlagsFromEnv(process.env))) {
      const { postProductionVoice } = await import("./production");
      return postProductionVoice(request);
    }
    assertSameOrigin(request);
    const user = await requireApiUser(request);
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return jsonNoStore({ error: "ElevenLabs is not connected yet. Add its API key to finish voice setup." }, { status: 503 });
    const { householdId } = await ensureUser(user);
    const existingVoice = await getDb().select({ id: voices.id }).from(voices).where(and(eq(voices.userId, user.userId), ne(voices.status, "deleted"))).get();
    if (existingVoice) return jsonNoStore({ error: "This account already has an active voice. Delete it before creating a replacement." }, { status: 409 });
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) return jsonNoStore({ error: "Voice setup requires multipart form data." }, { status: 400 });
    let form: FormData;
    try {
      const upload = await readLimitedBytes(request, 26_000_000);
      form = await new Response(upload, { headers: { "content-type": contentType } }).formData();
    } catch (error) {
      if (error instanceof Response) return error;
      return jsonNoStore({ error: "Voice setup form data is invalid." }, { status: 400 });
    }
    const sample = form.get("sample");
    const consent = form.get("consent") === "true";
    const name = Array.from(String(form.get("name") || "Parent voice"))
      .filter((character) => character !== "<" && character !== ">" && character.charCodeAt(0) > 31)
      .join("")
      .trim()
      .slice(0, 80) || "Parent voice";
    if (!consent) return jsonNoStore({ error: "Voice consent is required." }, { status: 400 });
    const allowedAudioTypes = new Set(["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"]);
    const sampleType = sample instanceof File ? sample.type.split(";", 1)[0].toLowerCase() : "";
    if (!(sample instanceof File) || sample.size < 10_000 || sample.size > 25_000_000 || !allowedAudioTypes.has(sampleType)) {
      return jsonNoStore({ error: "Record a valid WebM, MP4, MP3, or WAV voice sample under 25 MB." }, { status: 400 });
    }

    const providerForm = new FormData();
    providerForm.append("name", name);
    providerForm.append("description", "Parent-owned voice for private bedtime narration");
    providerForm.append("files", sample, sample.name || "voice-sample.webm");
    providerForm.append("remove_background_noise", "true");
    const response = await fetchWithTimeout(`${ELEVENLABS}/voices/add`, { method: "POST", headers: { "xi-api-key": apiKey }, body: providerForm }, 90_000);
    const payload = await response.json() as { voice_id?: string; detail?: { message?: string; status?: string; code?: string } | string };
    if (!response.ok || !payload.voice_id) {
      const failure = classifyVoiceCreationError(response.status, payload);
      const demoEnabled = failure.code === "voice_cloning_unavailable" && demoNarratorEnabled();
      console.error("ElevenLabs voice creation failed", response.status, failure.code);
      return jsonNoStore({ error: `${failure.message}${demoEnabled ? " You can continue with the demo narrator for testing; it is not your voice." : ""}`, code: failure.code, demoEnabled }, { status: failure.httpStatus });
    }

    const consentedAt = new Date();
    const voiceId = crypto.randomUUID();
    const consentId = crypto.randomUUID();
    const db = getDb();
    try {
      await db.insert(voices).values({ id: voiceId, userId: user.userId, householdId, currentConsentId: null, providerVoiceId: payload.voice_id, name, status: "ready", consentAttestedAt: consentedAt, createdAt: consentedAt });
      await db.insert(voiceConsents).values({
        id: consentId,
        householdId,
        voiceId,
        adultUserId: user.userId,
        consentVersion: "legacy-voice-checkbox-v1",
        scope: "adult_self_private_narration",
        status: "pending_verification",
        evidence: { kind: "legacy_checkbox_attestation", verified: false, posthumousSynthesis: false },
        attestedAt: consentedAt,
      });
      await db.update(voices).set({ currentConsentId: consentId }).where(eq(voices.id, voiceId));
      await db.update(users).set({ consentVersion: "legacy-voice-checkbox-v1", consentedAt, updatedAt: consentedAt }).where(eq(users.id, user.userId));
    } catch (error) {
      try { await db.delete(voices).where(eq(voices.id, voiceId)); } catch { /* retried account cleanup handles a failed local rollback */ }
      try {
        await fetchWithTimeout(`${ELEVENLABS}/voices/${encodeURIComponent(payload.voice_id)}`, { method: "DELETE", headers: { "xi-api-key": apiKey } });
      } catch { /* provider cleanup will be reconciled from request logs */ }
      throw error;
    }
    return jsonNoStore({ voiceId: payload.voice_id });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: "Voice setup failed. Please try again." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    if (nearSleepProductionEnabled(featureFlagsFromEnv(process.env))) {
      const { deleteProductionVoice } = await import("./production");
      return deleteProductionVoice(request);
    }
    assertSameOrigin(request);
    const user = await requireApiUser(request);
    const { householdId } = await ensureUser(user);
    const searchParams = new URL(request.url).searchParams;
    const voiceId = searchParams.get("voiceId");
    const deleteAll = searchParams.get("all") === "true";
    if (!voiceId && !deleteAll) return jsonNoStore({ error: "A voice ID is required." }, { status: 400 });
    const db = getDb();
    let records: Array<typeof voices.$inferSelect>;
    if (deleteAll) {
      records = await db.select().from(voices).where(and(eq(voices.userId, user.userId), ne(voices.status, "deleted"))).all();
    } else {
      const record = await db.select().from(voices).where(and(eq(voices.providerVoiceId, voiceId!), eq(voices.userId, user.userId))).get();
      if (!record) return jsonNoStore({ error: "Voice not found." }, { status: 404 });
      records = [record];
    }
    if (!records.length) return jsonNoStore({ error: "Voice not found." }, { status: 404 });
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return jsonNoStore({ error: "ElevenLabs is not connected." }, { status: 503 });
    for (const record of records) {
      const response = await fetchWithTimeout(`${ELEVENLABS}/voices/${encodeURIComponent(record.providerVoiceId)}`, { method: "DELETE", headers: { "xi-api-key": apiKey } });
      if (!response.ok && response.status !== 404) return jsonNoStore({ error: "The provider could not delete this voice." }, { status: 502 });
      await db.update(voices).set({ status: "deleted", deletedAt: new Date() }).where(eq(voices.id, record.id));
      await db.update(voiceConsents).set({ status: "revoked", revokedAt: new Date() })
        .where(and(eq(voiceConsents.householdId, householdId), eq(voiceConsents.voiceId, record.id)));
    }
    return jsonNoStore({ deleted: true, count: records.length });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: "Voice deletion failed." }, { status: 500 });
  }
}
