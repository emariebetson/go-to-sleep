import { env } from "cloudflare:workers";
import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { sleepSessions, usageEvents, users, voices } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { ensureUser } from "@/lib/data";
import { assertSameOrigin, fetchWithTimeout, jsonNoStore, readJsonObject } from "@/lib/http";
import { previewExcerpt, validateSessionInput } from "@/lib/sleep-session";

type AudioBucket = {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  delete(key: string): Promise<void>;
};
type RuntimeEnv = { AUDIO?: AudioBucket };

const labels: Record<string, string> = { "moonlit-meadow": "Moonlit Meadow", "sleepy-sea": "Sleepy Sea", "cloud-garden": "Cloud Garden" };

async function generateSpeech(apiKey: string, providerVoiceId: string, text: string) {
  return fetchWithTimeout(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(providerVoiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
      voice_settings: { stability: 0.78, similarity_boost: 0.75, style: 0.12, use_speaker_boost: true },
    }),
  }, 90_000);
}

export async function POST(request: Request) {
  let sessionId = "";
  let creditReserved = false;
  let reservedUserId = "";
  let sessionClaimed = false;
  let storedAudioKey = "";
  async function refundCredit() {
    if (!creditReserved || !reservedUserId) return;
    try {
      await getDb().update(users).set({ creditsRemaining: sql`${users.creditsRemaining} + 1`, updatedAt: new Date() }).where(eq(users.id, reservedUserId));
      creditReserved = false;
    } catch (error) { console.error("Credit refund failed", reservedUserId, sessionId, error); }
  }
  try {
    assertSameOrigin(request);
    const user = await requireApiUser(request);
    const input = validateSessionInput(await readJsonObject(request, 24_000));
    sessionId = input.requestId;
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return jsonNoStore({ error: "ElevenLabs is not connected yet. Add its API key to generate audio." }, { status: 503 });
    await ensureUser(user);
    const db = getDb();
    const ownedVoice = await db.select({ id: voices.id })
      .from(voices)
      .where(and(eq(voices.userId, user.userId), eq(voices.providerVoiceId, input.providerVoiceId), eq(voices.status, "ready")))
      .get();
    if (!ownedVoice) return jsonNoStore({ error: "That voice profile is unavailable. Create or select your own voice first." }, { status: 404 });

    if (input.generationMode === "preview") {
      const response = await generateSpeech(apiKey, input.providerVoiceId, previewExcerpt(input.script));
      if (!response.ok) {
        const detail = await response.text();
        console.error("ElevenLabs preview failed", response.status, detail.slice(0, 400));
        return jsonNoStore({ error: "The 30-second sample is temporarily unavailable." }, { status: 502 });
      }
      return new Response(await response.arrayBuffer(), {
        headers: {
          "content-type": "audio/mpeg",
          "cache-control": "private, no-store",
          "content-disposition": "inline; filename=nearnight-sample.mp3",
          "x-nearnight-preview": "30-seconds",
        },
      });
    }

    const now = new Date();
    const title = input.sourceTitle || `${labels[input.theme] || "A gentle bedtime"}${input.contentType === "sleep-hypnosis" ? " relaxation" : ""}`;
    const claimed = await db.insert(sleepSessions).values({
      id: sessionId,
      userId: user.userId,
      voiceId: ownedVoice.id,
      title,
      script: input.script,
      scriptMode: input.scriptMode,
      contentType: input.contentType,
      sourceUrl: input.sourceUrl || null,
      sourceTitle: input.sourceTitle || null,
      theme: input.theme,
      style: input.style,
      backgroundSound: input.sound,
      durationMinutes: input.durationMinutes,
      status: "queued",
      createdAt: now,
    }).onConflictDoNothing().returning({ id: sleepSessions.id }).get();
    if (!claimed) {
      const existing = await db.select({ status: sleepSessions.status, audioKey: sleepSessions.audioKey })
        .from(sleepSessions)
        .where(and(eq(sleepSessions.id, sessionId), eq(sleepSessions.userId, user.userId)))
        .get();
      if (existing?.status === "ready" && existing.audioKey) return jsonNoStore({ sessionId, audioUrl: `/api/audio/${sessionId}`, duplicate: true });
      return jsonNoStore({ error: "This generation request is already being processed. Check My nights before trying again." }, { status: 409 });
    }
    sessionClaimed = true;
    reservedUserId = user.userId;
    const reservation = await db.update(users)
      .set({ creditsRemaining: sql`${users.creditsRemaining} - 1`, updatedAt: new Date() })
      .where(and(eq(users.id, user.userId), gt(users.creditsRemaining, 0)))
      .returning({ remaining: users.creditsRemaining }).get();
    if (!reservation) {
      await db.delete(sleepSessions).where(eq(sleepSessions.id, sessionId));
      sessionClaimed = false;
      return jsonNoStore({ error: "You have no generation credits remaining. Choose a plan or add a session pack." }, { status: 402 });
    }
    creditReserved = true;
    await db.update(sleepSessions).set({ status: "generating" }).where(eq(sleepSessions.id, sessionId));

    const response = await generateSpeech(apiKey, input.providerVoiceId, input.script);
    if (!response.ok) {
      const detail = await response.text();
      console.error("ElevenLabs generation failed", response.status, detail.slice(0, 400));
      await db.update(sleepSessions).set({ status: "failed", errorCode: `elevenlabs_${response.status}` }).where(eq(sleepSessions.id, sessionId));
      await refundCredit();
      return jsonNoStore({ error: "Audio generation is temporarily unavailable." }, { status: 502 });
    }
    const audio = await response.arrayBuffer();
    const runtime = env as unknown as RuntimeEnv;
    const audioKey = `audio/${user.userId}/${sessionId}.mp3`;

    if (runtime.AUDIO) {
      await runtime.AUDIO.put(audioKey, audio, { httpMetadata: { contentType: "audio/mpeg" }, customMetadata: { userId: user.userId, sessionId } });
      storedAudioKey = audioKey;
      const completedAt = new Date();
      await db.update(sleepSessions).set({ status: "ready", audioKey, providerRequestId: response.headers.get("request-id"), completedAt }).where(eq(sleepSessions.id, sessionId));
      await db.insert(usageEvents).values({ id: crypto.randomUUID(), userId: user.userId, sessionId, type: "audio_generation", units: input.script.length, metadata: { provider: "elevenlabs" }, createdAt: completedAt });
      creditReserved = false;
      return jsonNoStore({ sessionId, audioUrl: `/api/audio/${sessionId}` });
    }

    await db.update(sleepSessions).set({ status: "ready", completedAt: new Date() }).where(eq(sleepSessions.id, sessionId));
    creditReserved = false;
    return new Response(audio, { headers: { "content-type": "audio/mpeg", "cache-control": "private, no-store", "content-disposition": `inline; filename="${sessionId}.mp3"` } });
  } catch (error) {
    if (error instanceof Response) return error;
    await refundCredit();
    if (sessionClaimed && sessionId) {
      try { await getDb().update(sleepSessions).set({ status: "failed", errorCode: "internal_error" }).where(eq(sleepSessions.id, sessionId)); } catch { /* original failure is logged below */ }
    }
    if (storedAudioKey) {
      try { await (env as unknown as RuntimeEnv).AUDIO?.delete(storedAudioKey); } catch { /* orphan cleanup is reconciled operationally */ }
    }
    console.error("Session generation failed", sessionId, error);
    return jsonNoStore({ error: "The bedtime could not be generated." }, { status: 500 });
  }
}
