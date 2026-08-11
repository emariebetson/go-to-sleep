import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { mediaAssets, sleepSessions } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { parseByteRange } from "@/lib/http-range";
import { safeAudioFilename } from "@/lib/nearsleep-library";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

type StoredAudioMetadata = { size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>; writeHttpMetadata(headers: Headers): void };
type StoredAudio = StoredAudioMetadata & { body: BodyInit | null };
type AudioBucket = {
  head(key: string): Promise<StoredAudioMetadata | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<StoredAudio | null>;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    let record: { audioKey: string | null; title: string; byteSize?: number | null; checksum?: string | null } | undefined;
    if (nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(process.env))) {
      const { requireHouseholdContext } = await import("@/lib/api-v1-context");
      const { householdId } = await requireHouseholdContext(request, "household:read");
      record = await getDb().select({ audioKey: sleepSessions.audioKey, title: sleepSessions.title, byteSize: mediaAssets.byteSize, checksum: mediaAssets.checksum }).from(sleepSessions).innerJoin(mediaAssets, and(
        eq(sleepSessions.mediaAssetId, mediaAssets.id),
        eq(mediaAssets.householdId, householdId),
        eq(mediaAssets.status, "ready"),
        eq(mediaAssets.private, true),
        isNull(mediaAssets.deletedAt),
        eq(mediaAssets.storageKey, sleepSessions.audioKey),
      )).where(and(
        eq(sleepSessions.id, id),
        eq(sleepSessions.householdId, householdId),
        eq(sleepSessions.status, "ready"),
        eq(sleepSessions.deletionStatus, "active"),
      )).get();
    } else {
      const user = await requireApiUser(request);
      record = await getDb().select({ audioKey: sleepSessions.audioKey, title: sleepSessions.title }).from(sleepSessions).where(and(eq(sleepSessions.id, id), eq(sleepSessions.userId, user.userId))).get();
    }
    if (!record?.audioKey) return new Response("Not found", { status: 404 });
    const bucket = (env as unknown as { AUDIO?: AudioBucket }).AUDIO;
    if (!bucket) return new Response("Audio storage is unavailable", { status: 503 });
    const metadata = await bucket.head(record.audioKey);
    if (!metadata) return new Response("Not found", { status: 404 });
    if (record.checksum && (metadata.size !== record.byteSize || metadata.customMetadata?.checksum !== record.checksum)) return new Response("Audio requires reconciliation", { status: 503 });
    const range = parseByteRange(request.headers.get("range"), metadata.size);
    if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "content-range": `bytes */${metadata.size}` } });
    const object = await bucket.get(record.audioKey, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
    if (!object?.body) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    metadata.writeHttpMetadata(headers);
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", "private, no-store");
    headers.set("content-disposition", `${new URL(request.url).searchParams.get("download") === "true" ? "attachment" : "inline"}; filename="${safeAudioFilename(record.title, id)}"`);
    headers.set("content-length", String(range ? range.end - range.start + 1 : metadata.size));
    headers.set("content-type", metadata.httpMetadata?.contentType || "audio/mpeg");
    headers.set("vary", "range");
    if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${metadata.size}`);
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response("Audio is unavailable", { status: 500 });
  }
}
