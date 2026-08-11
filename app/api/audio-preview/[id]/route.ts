import { env } from "cloudflare:workers";
import { requireHouseholdContext } from "@/lib/api-v1-context";
import { previewAudioStorageKey } from "@/lib/nearsleep-audio";
import { requireCurrentAdultOnboarding, validateConsumedVoiceConsentLease } from "@/lib/nearsleep-live";
import { featureFlagsFromEnv, nearSleepProductionEnabled } from "@/lib/nearyou-foundation";
import { parseByteRange } from "@/lib/http-range";

type StoredAudioMetadata = {
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  writeHttpMetadata(headers: Headers): void;
};
type StoredAudio = StoredAudioMetadata & { body: BodyInit | null };
type AudioBucket = {
  head(key: string): Promise<StoredAudioMetadata | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<StoredAudio | null>;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!nearSleepProductionEnabled(featureFlagsFromEnv(process.env))) return new Response("Not found", { status: 404 });
  try {
    const { householdId, user } = await requireHouseholdContext(request, "playlist:read");
    await requireCurrentAdultOnboarding({ householdId, userId: user.userId });
    const { id } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return new Response("Not found", { status: 404 });
    const storageKey = previewAudioStorageKey(householdId, id);
    const audio = (env as unknown as { AUDIO?: AudioBucket }).AUDIO;
    if (!audio) return new Response("Audio storage is unavailable", { status: 503 });
    const metadata = await audio.head(storageKey);
    if (!metadata
      || metadata.customMetadata?.householdId !== householdId
      || metadata.customMetadata?.userId !== user.userId
      || metadata.customMetadata?.requestId !== id) return new Response("Not found", { status: 404 });
    const leaseId = metadata.customMetadata.leaseId;
    if (leaseId && !await validateConsumedVoiceConsentLease({ householdId, userId: user.userId }, leaseId, null)) return new Response("Not found", { status: 404 });
    const range = parseByteRange(request.headers.get("range"), metadata.size);
    if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "content-range": `bytes */${metadata.size}` } });
    const object = await audio.get(storageKey, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
    if (!object?.body) return new Response("Not found", { status: 404 });
    const headers = new Headers({
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-disposition": "inline; filename=nearsleep-preview.mp3",
      "content-length": String(range ? range.end - range.start + 1 : metadata.size),
      "content-type": metadata.httpMetadata?.contentType || "audio/mpeg",
      "vary": "range",
    });
    metadata.writeHttpMetadata(headers);
    if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${metadata.size}`);
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("NearSleep preview playback failed", error);
    return new Response("Audio is unavailable", { status: 500 });
  }
}
