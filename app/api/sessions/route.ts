import { env } from "cloudflare:workers";
import { and, eq, gt, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { childProfiles, children, sleepSessions, usageEvents, users, voiceConsents, voices } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { ensureUser } from "@/lib/data";
import { assertSameOrigin, fetchWithTimeout, jsonNoStore, readJsonObject } from "@/lib/http";
import { validateSessionInput } from "@/lib/sleep-session";
import { demoNarratorEnabled } from "@/lib/demo-narrator";
import { classifySpeechGenerationError } from "@/lib/elevenlabs";
import { normalizeNickname } from "@/lib/pronunciation";
import { prepareNarration } from "@/lib/session-narration";
import { featureFlagsFromEnv } from "@/lib/nearyou-foundation";

type AudioBucket = {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  delete(key: string): Promise<void>;
};
type RuntimeEnv = { AUDIO?: AudioBucket };

const labels: Record<string, string> = { "moonlit-meadow": "Moonlit Meadow", "sleepy-sea": "Sleepy Sea", "cloud-garden": "Cloud Garden" };
// Jessica is an ElevenLabs default voice. This public catalog ID is not a secret.
const DEFAULT_DEMO_VOICE_ID = "cgSgspJ2msm6clMCkdW9";
const MAX_PREVIEWS_PER_HOUR = 5;

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
  if (featureFlagsFromEnv(process.env).nearSleepProduction) {
    const { postProductionSession } = await import("./production");
    return postProductionSession(request);
  }
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
    const narration = prepareNarration(input);
    sessionId = input.requestId;
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return jsonNoStore({ error: "ElevenLabs is not connected yet. Add its API key to generate audio." }, { status: 503 });
    const { householdId } = await ensureUser(user);
    const db = getDb();
    const isDemoNarrator = input.narrationKind === "demo_narrator";
    const requireVerifiedConsent = featureFlagsFromEnv(process.env).requireVerifiedVoiceConsent;
    if (isDemoNarrator && !demoNarratorEnabled()) return jsonNoStore({ error: "Demo narration is unavailable." }, { status: 403 });
    const ownedVoice = isDemoNarrator ? null : await db.select({ id: voices.id })
      .from(voices)
      .leftJoin(voiceConsents, eq(voices.currentConsentId, voiceConsents.id))
      .where(and(
        eq(voices.userId, user.userId),
        eq(voices.householdId, householdId),
        eq(voices.providerVoiceId, input.providerVoiceId),
        eq(voices.status, "ready"),
        ...(requireVerifiedConsent ? [
          eq(voiceConsents.householdId, householdId),
          eq(voiceConsents.adultUserId, user.userId),
          eq(voiceConsents.status, "active_verified"),
        ] : []),
      ))
      .get();
    if (!isDemoNarrator && !ownedVoice) return jsonNoStore({ error: requireVerifiedConsent ? "That voice requires current verified adult consent before narration." : "That voice profile is unavailable. Create or select your own voice first." }, { status: requireVerifiedConsent ? 403 : 404 });
    const providerVoiceId = isDemoNarrator
      ? process.env.ELEVENLABS_DEMO_VOICE_ID || DEFAULT_DEMO_VOICE_ID
      : input.providerVoiceId;

    if (input.generationMode === "preview") {
      const previewCreatedAt = new Date();
      const previewUsageId = `preview:${input.requestId}`;
      const entitlement = await db.select({ creditsRemaining: users.creditsRemaining }).from(users)
        .where(and(eq(users.id, user.userId), gt(users.creditsRemaining, 0))).get();
      if (!entitlement) return jsonNoStore({ error: "You have no generation credits remaining. Choose a plan or add a session pack." }, { status: 402 });
      const inserted = await db.insert(usageEvents).values({
        id: previewUsageId,
        userId: user.userId,
        householdId,
        type: "audio_preview",
        units: narration.preview.length,
        metadata: { provider: "elevenlabs", narrationKind: input.narrationKind },
        createdAt: previewCreatedAt,
      }).onConflictDoNothing().returning({ id: usageEvents.id }).get();
      if (!inserted) return jsonNoStore({ error: "That preview request was already used. Create a new sample request." }, { status: 409 });
      const previewWindowStart = new Date(previewCreatedAt.getTime() - 60 * 60 * 1000);
      const previewCount = await db.select({ value: sql<number>`count(*)` }).from(usageEvents)
        .where(and(eq(usageEvents.userId, user.userId), eq(usageEvents.type, "audio_preview"), gte(usageEvents.createdAt, previewWindowStart)))
        .get();
      if ((previewCount?.value || 0) > MAX_PREVIEWS_PER_HOUR) {
        await db.delete(usageEvents).where(eq(usageEvents.id, previewUsageId));
        return jsonNoStore({ error: "You’ve reached the preview limit. Try again in about an hour." }, { status: 429 });
      }
      const response = await generateSpeech(apiKey, providerVoiceId, narration.preview);
      if (!response.ok) {
        const detail = await response.text();
        const failure = classifySpeechGenerationError(response.status, detail);
        console.error("ElevenLabs preview failed", response.status, detail.slice(0, 400));
        return jsonNoStore({ error: failure.message, code: failure.code }, { status: failure.httpStatus });
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
      householdId,
      voiceId: ownedVoice?.id || null,
      title,
      script: input.script,
      pronunciation: input.pronunciation,
      frequencyLayers: JSON.stringify(input.frequencies),
      scriptMode: input.scriptMode,
      contentType: input.contentType,
      narrationKind: input.narrationKind,
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

    const response = await generateSpeech(apiKey, providerVoiceId, narration.full);
    if (!response.ok) {
      const detail = await response.text();
      const failure = classifySpeechGenerationError(response.status, detail);
      console.error("ElevenLabs generation failed", response.status, detail.slice(0, 400));
      await db.update(sleepSessions).set({ status: "failed", errorCode: `elevenlabs_${response.status}` }).where(eq(sleepSessions.id, sessionId));
      await refundCredit();
      return jsonNoStore({ error: failure.message, code: failure.code }, { status: failure.httpStatus });
    }
    const audio = await response.arrayBuffer();
    const childSavedAt = new Date();
    const child = await db.insert(children).values({
      id: crypto.randomUUID(),
      userId: user.userId,
      householdId,
      nickname: input.childName,
      normalizedNickname: normalizeNickname(input.childName),
      pronunciation: input.pronunciation || null,
      ageMonths: input.ageMonths,
      bedtimeChallenge: input.challenge,
      createdAt: childSavedAt,
      updatedAt: childSavedAt,
    }).onConflictDoUpdate({
      target: [children.userId, children.normalizedNickname],
      set: {
        nickname: input.childName,
        pronunciation: input.pronunciation || null,
        ageMonths: input.ageMonths,
        bedtimeChallenge: input.challenge,
        updatedAt: childSavedAt,
      },
    }).returning({ id: children.id }).get();
    if (!child) throw new Error("The child settings could not be saved.");
    const childProfileId = `child-profile:${child.id}`;
    await db.insert(childProfiles).values({
      id: childProfileId,
      householdId,
      legacyChildId: child.id,
      nickname: input.childName,
      normalizedNickname: normalizeNickname(input.childName),
      pronunciation: input.pronunciation,
      ageMonths: input.ageMonths,
      bedtimeChallenge: input.challenge,
      createdAt: childSavedAt,
      updatedAt: childSavedAt,
    }).onConflictDoUpdate({
      target: [childProfiles.householdId, childProfiles.normalizedNickname],
      set: { legacyChildId: child.id, nickname: input.childName, pronunciation: input.pronunciation, ageMonths: input.ageMonths, bedtimeChallenge: input.challenge, updatedAt: childSavedAt },
    });
    await db.update(children).set({ householdId, profileId: childProfileId }).where(eq(children.id, child.id));
    const runtime = env as unknown as RuntimeEnv;
    const audioKey = `audio/${user.userId}/${sessionId}.mp3`;

    if (runtime.AUDIO) {
      await runtime.AUDIO.put(audioKey, audio, { httpMetadata: { contentType: "audio/mpeg" }, customMetadata: { userId: user.userId, sessionId } });
      storedAudioKey = audioKey;
      const completedAt = new Date();
      await db.update(sleepSessions).set({ status: "ready", childId: child.id, audioKey, providerRequestId: response.headers.get("request-id"), completedAt }).where(eq(sleepSessions.id, sessionId));
      await db.insert(usageEvents).values({ id: crypto.randomUUID(), userId: user.userId, householdId, sessionId, type: "audio_generation", units: input.script.length, metadata: { provider: "elevenlabs" }, createdAt: completedAt });
      creditReserved = false;
      return jsonNoStore({ sessionId, audioUrl: `/api/audio/${sessionId}` });
    }

    await db.update(sleepSessions).set({ status: "ready", childId: child.id, completedAt: new Date() }).where(eq(sleepSessions.id, sessionId));
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
