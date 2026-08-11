import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { sleepSessions } from "@/db/schema";
import { requireApiUser } from "@/lib/auth";
import { parseByteRange } from "@/lib/http-range";

type StoredAudioMetadata = { size: number; httpMetadata?: { contentType?: string }; writeHttpMetadata(headers: Headers): void };
type StoredAudio = StoredAudioMetadata & { body: BodyInit | null };
type AudioBucket = {
  head(key: string): Promise<StoredAudioMetadata | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<StoredAudio | null>;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiUser(request);
    const { id } = await context.params;
    const record = await getDb().select({ audioKey: sleepSessions.audioKey }).from(sleepSessions).where(and(eq(sleepSessions.id, id), eq(sleepSessions.userId, user.userId))).get();
    if (!record?.audioKey) return new Response("Not found", { status: 404 });
    const bucket = (env as unknown as { AUDIO?: AudioBucket }).AUDIO;
    if (!bucket) return new Response("Audio storage is unavailable", { status: 503 });
    const metadata = await bucket.head(record.audioKey);
    if (!metadata) return new Response("Not found", { status: 404 });
    const range = parseByteRange(request.headers.get("range"), metadata.size);
    if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "content-range": `bytes */${metadata.size}` } });
    const object = await bucket.get(record.audioKey, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
    if (!object?.body) return new Response("Not found", { status: 404 });
    const headers = new Headers({
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "content-disposition": `inline; filename="nearnight-${id}.mp3"`,
      "content-length": String(range ? range.end - range.start + 1 : metadata.size),
      "content-type": metadata.httpMetadata?.contentType || "audio/mpeg",
      "vary": "range",
    });
    metadata.writeHttpMetadata(headers);
    if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${metadata.size}`);
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response("Audio is unavailable", { status: 500 });
  }
}
