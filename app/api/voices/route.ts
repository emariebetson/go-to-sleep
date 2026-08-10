import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { users, voices } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { ensureUser } from "@/lib/data";
import { assertSameOrigin, fetchWithTimeout, jsonNoStore } from "@/lib/http";

const ELEVENLABS = "https://api.elevenlabs.io/v1";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireApiUser();
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return jsonNoStore({ error: "ElevenLabs is not connected yet. Add its API key to finish voice setup." }, { status: 503 });
    await ensureUser(user);
    const existingVoice = await getDb().select({ id: voices.id }).from(voices).where(and(eq(voices.userId, user.userId), ne(voices.status, "deleted"))).get();
    if (existingVoice) return jsonNoStore({ error: "This account already has an active voice. Delete it before creating a replacement." }, { status: 409 });
    const declaredLength = Number(request.headers.get("content-length") || "0");
    if (declaredLength > 26_000_000) return jsonNoStore({ error: "Voice sample is too large." }, { status: 413 });
    const form = await request.formData();
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
    const payload = await response.json() as { voice_id?: string; detail?: { message?: string } | string };
    if (!response.ok || !payload.voice_id) {
      const detail = typeof payload.detail === "string" ? payload.detail : payload.detail?.message;
      return jsonNoStore({ error: detail || "ElevenLabs could not create the voice profile." }, { status: response.status || 502 });
    }

    const consentedAt = new Date();
    try {
      const db = getDb();
      await db.insert(voices).values({ id: crypto.randomUUID(), userId: user.userId, providerVoiceId: payload.voice_id, name, status: "ready", consentAttestedAt: consentedAt, createdAt: consentedAt });
      await db.update(users).set({ consentVersion: "voice-v1", consentedAt, updatedAt: consentedAt }).where(eq(users.id, user.userId));
    } catch (error) {
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
    assertSameOrigin(request);
    const user = await requireApiUser();
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
    }
    return jsonNoStore({ deleted: true, count: records.length });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonNoStore({ error: "Voice deletion failed." }, { status: 500 });
  }
}
